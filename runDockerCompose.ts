import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export function createDockerComposeAction() {
  return createTemplateAction({
    id: 'custom:docker-compose',
    description: 'Runs docker compose, removes conflicting containers, rebuilds images, and returns exposed ports',

    schema: {
      input: {
        type: 'object',
        required: ['composeFile'],
        properties: {
          composeFile: { type: 'string' },
          workDir: { type: 'string' },
        },
      },
      output: {
        type: 'object',
        properties: {
          ports: {
            type: 'object',
            description: 'Detected host ports for each service',
            additionalProperties: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  hostPort: { type: 'string' },
                  containerPort: { type: 'string' },
                },
              },
            },
          },
          webUrl: {
            type: 'string',
            description: 'URL of the first web service detected',
          },
        },
      },
    },

    async handler(ctx) {
      const cwd = ctx.input.workDir ?? ctx.workspacePath;
      const composePath = path.join(cwd, ctx.input.composeFile);

      ctx.logger.info(`Compose file: ${composePath}`);

      if (!fs.existsSync(composePath)) {
        throw new Error(`Compose file not found: ${composePath}`);
      }

      // === Step 1: Parse docker-compose.yml to get services ===
      let serviceNames: string[] = [];
      let composeDoc: any = {};
      try {
        const yaml = await import('js-yaml');
        const composeContent = fs.readFileSync(composePath, 'utf8');
        composeDoc = yaml.load(composeContent) as any;
        if (composeDoc.services) {
          serviceNames = Object.keys(composeDoc.services);
          ctx.logger.info(`Detected services: ${serviceNames.join(', ')}`);
        }
      } catch (err) {
        ctx.logger.warn(`Failed to parse compose file: ${err}`);
      }

      // =====================================================
      // === Step 2: REMOVE CONTAINERS BY NAME AND BY PORT ===
      // =====================================================

      const composeDirName = path.basename(cwd);

      interface SvcInfo {
        service: string;
        containerName: string;
        expectedHostPorts: string[];
      }

      const svcInfos: SvcInfo[] = [];

      for (const service of serviceNames) {
        const def = composeDoc.services[service];

        const containerName = def.container_name
          ? def.container_name
          : `${composeDirName}_${service}_1`;

        const expectedHostPorts: string[] = [];
        if (def.ports) {
          for (const p of def.ports) {
            const parts = p.toString().split(':');
            if (parts.length >= 2) {
              expectedHostPorts.push(parts[0]);
            }
          }
        }

        svcInfos.push({ service, containerName, expectedHostPorts });
      }

      ctx.logger.info(`Service cleanup info: ${JSON.stringify(svcInfos)}`);

      async function removeContainer(name: string) {
        await new Promise<void>((resolve) => {
          const cmd = `docker ps -a --filter "name=^${name}$" --format "{{.Names}}" | xargs -r docker rm -f`;
          const rmProc = spawn('/usr/bin/bash', ['-c', cmd]);

          rmProc.stdout.on('data', d => ctx.logger.info(`[RM] ${d.toString()}`));
          rmProc.stderr.on('data', d => ctx.logger.warn(`[RM ERR] ${d.toString()}`));
          rmProc.on('close', () => resolve());
        });
      }

      // Remove containers by name
      for (const svc of svcInfos) {
        ctx.logger.info(`Removing container by name: ${svc.containerName}`);
        await removeContainer(svc.containerName);
      }

      // Remove containers blocking ports
      for (const svc of svcInfos) {
        for (const port of svc.expectedHostPorts) {
          ctx.logger.info(`Checking port conflict for host port: ${port}`);

          const conflictingContainers = await new Promise<string[]>((resolve) => {
            const cmd = `docker ps --format "{{.Names}}:::{{.Ports}}"`;
            const proc = spawn('/usr/bin/bash', ['-c', cmd]);

            let out = '';
            proc.stdout.on('data', d => (out += d.toString()));
            proc.on('close', () => {
              const results: string[] = [];
              out.trim().split('\n').forEach(line => {
                const [name, ports] = line.split(':::');
                if (ports && ports.includes(`${port}->`)) {
                  results.push(name);
                }
              });
              resolve(results);
            });
          });

          for (const container of conflictingContainers) {
            ctx.logger.warn(`Host port ${port} is in use by ${container}. Removing...`);
            await removeContainer(container);
          }
        }
      }

      // === Step 3: Run docker compose up -d --build ===
      ctx.logger.info('Starting Docker Compose...');
      await new Promise<void>((resolve, reject) => {
        const upProc = spawn(
          '/usr/bin/docker',
          ['compose', '-f', composePath, 'up', '-d', '--build'],
          { cwd }
        );

        upProc.stdout.on('data', data => ctx.logger.info(`DOCKER OUT: ${data.toString()}`));
        upProc.stderr.on('data', data => {
          const str = data.toString();
          if (str.includes('Creating') || str.includes('Created') || str.includes('level=warning')) {
            ctx.logger.warn(`DOCKER WARN: ${str}`);
          } else {
            ctx.logger.warn(`DOCKER ERR: ${str}`);
          }
        });

        upProc.on('close', code => {
          if (code === 0) {
            ctx.logger.info('Docker Compose executed successfully.');
            resolve();
          } else {
            ctx.logger.error(`docker compose up exited with code ${code}`);
            reject(new Error(`docker compose up exited with code ${code}`));
          }
        });
      });

      // === Step 4: Detect exposed ports ===
      const ports: Record<string, Array<{ hostPort: string; containerPort: string }>> = {};

      for (const service of serviceNames) {
        await new Promise<void>((resolve) => {
          const inspectProc = spawn('/usr/bin/bash', [
            '-c',
            `docker ps --filter "name=${service}" --format "{{.Names}}" | xargs -r -I {} docker port {}`
          ]);

          let output = '';
          inspectProc.stdout.on('data', data => output += data.toString());
          inspectProc.stderr.on('data', data => ctx.logger.warn(`DOCKER WARN: ${data.toString()}`));

          inspectProc.on('close', () => {
            const mappings: Array<{ hostPort: string; containerPort: string }> = [];
            output.split('\n').forEach(line => {
              if (line.trim()) {
                const match = line.match(/^(\d+)\/tcp -> [^:]+:(\d+)$/);
                if (match) {
                  mappings.push({ containerPort: match[1], hostPort: match[2] });
                }
              }
            });
            ports[service] = mappings;
            resolve();
          });
        });
      }

      ctx.logger.info(`Exposed ports: ${JSON.stringify(ports)}`);

      // === Step 5: Pick first web URL
      let webUrl = '';
      for (const [service, mappings] of Object.entries(ports)) {
        if (mappings.length > 0) {
          webUrl = `http://localhost:${mappings[0].hostPort}`;
          break;
        }
      }

      ctx.output('ports', ports);
      ctx.output('webUrl', webUrl);
      ctx.logger.info(`Application available at: ${webUrl}`);

      return { webUrl, ports };
    },
  });
}

export const dockerComposeModule = createBackendModule({
  moduleId: 'docker-compose-actions',
  pluginId: 'scaffolder',
  register(env) {
    env.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createDockerComposeAction());
      },
    });
  },
});
