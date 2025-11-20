import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction, executeShellCommand } from '@backstage/plugin-scaffolder-node';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { z } from 'zod';

/**
 * Backend module that adds a `shell:run` scaffolder action.
 * WARNING: running shell commands is dangerous — restrict to dev/local usage.
 */
export const scaffolderShellModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'shell-actions',
  register(env) {
    env.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createShellRunAction());
      },
    });
  },
});

export default scaffolderShellModule;

/*function createShellRunAction() {
  return createTemplateAction({
    id: 'shell:run',
    description: 'Run a shell command in the template workspace (dev only).',
    schema: {
      input: z.object({
        command: z.string().describe('Command or executable to run (e.g. "npm" or "./script.sh")'),
        args: z.array(z.string()).optional().describe('Arguments array'),
        cwd: z.string().optional().describe('Optional workspace-relative working dir'),
      }),
    },
    async handler(ctx) {
      const cmd = ctx.input.command;
      const args = ctx.input.args ?? [];
      const cwd = ctx.input.cwd
        ? resolveSafeChildPath(ctx.workspacePath, ctx.input.cwd)
        : ctx.workspacePath;

      // executeShellCommand accepts { command, args, options?, logger?, logStream? }
      await executeShellCommand({
        command: cmd,
        args,
        options: { cwd },
        logStream: ctx.logStream,
      });
    },
  });
}*/

function createShellRunAction() {
  return createTemplateAction({
    id: 'shell:run',
    description: 'Run a shell command in the template workspace (dev only).',
    schema: {
      input: z.object({
        command: z.string().describe('Executable to run, e.g. "echo" or "npm"'),
        args: z.array(z.string()).optional().describe('Arguments'),
        cwd: z.string().optional().describe('Working directory (workspace-relative)'),
      }),
    },
    async handler(ctx) {
      const cmd = ctx.input.command?.trim();
      if (!cmd) {
        throw new Error(`shell:run requires a "command" input`);
      }

      const args = ctx.input.args ?? [];
      const cwd = ctx.input.cwd
        ? resolveSafeChildPath(ctx.workspacePath, ctx.input.cwd)
        : ctx.workspacePath;

      ctx.logger.info(`Running command: ${cmd} ${args.join(' ')} in ${cwd}`);

      await executeShellCommand({
        command: cmd,
        args,
        options: { cwd },
        logStream: ctx.logStream,
      });
    },
  });
}
