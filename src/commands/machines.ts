import * as os from 'os';

import * as vscode from 'vscode';

import {
  defaultMachineName,
  type HomeMount,
  isValidMachineName,
  isValidMemory,
  machineCreateArgs,
  machineSetArgs,
  machineStartArgs,
  memoryValue,
} from '../services/machine';
import {schemeArgs} from '../utils/registry';
import {openCliTerminal, runCliTask} from '../ui/terminal';
import type {MachineSummary} from '../models/types';
import type {MachineNode} from '../views/machines';
import {logTail} from './containers';
import {openMachineOverSsh} from './remoteSsh';
import {
  ask,
  CommandContext,
  confirm,
  register,
  selection,
  withProgress,
} from './common';

/** Booting runs the image's init and sets up the account; pulling is done by create, so this is only a safety net */
const BOOT_TIMEOUT_MS = 5 * 60_000;

export function registerMachineCommands(ctx: CommandContext): void {
  const {cli} = ctx;
  const refresh = () => ctx.views.machines.refresh();

  register(ctx, 'appleContainer.machine.create', async () => {
    const options = await askCreateOptions(ctx);
    if (!options) {
      return;
    }
    const code = await runCliTask(
      cli,
      vscode.l10n.t('Create Machine {0}', options.name),
      machineCreateArgs(options),
    );
    refresh();
    if (code !== 0) {
      return;
    }
    const shell = vscode.l10n.t('Open Shell');
    const ssh = vscode.l10n.t('Open in Remote-SSH');
    const answer = await vscode.window.showInformationMessage(
      vscode.l10n.t('Machine {0} is running.', options.name),
      shell,
      ssh,
    );
    if (answer === shell) {
      await openMachineShell(ctx, options.name, false);
    } else if (answer === ssh) {
      await openMachineOverSsh(ctx, {id: options.name});
    }
  });

  register(ctx, 'appleContainer.machine.shell', async (node?: MachineNode) => {
    if (node) {
      await openMachineShell(ctx, node.resource.id, false);
    }
  });

  register(
    ctx,
    'appleContainer.machine.rootShell',
    async (node?: MachineNode) => {
      if (node) {
        await openMachineShell(ctx, node.resource.id, true);
      }
    },
  );

  register(
    ctx,
    'appleContainer.machine.start',
    async (node?: MachineNode, nodes?: MachineNode[]) => {
      const items = selection(node, nodes);
      if (!items.length) {
        return;
      }
      await withProgress(
        vscode.l10n.t('Starting {0}...', names(items)),
        async () => {
          for (const m of items) {
            await cli.run(machineStartArgs(m.id), {timeoutMs: BOOT_TIMEOUT_MS});
          }
        },
      );
      refresh();
    },
  );

  register(
    ctx,
    'appleContainer.machine.stop',
    async (node?: MachineNode, nodes?: MachineNode[]) => {
      const items = selection(node, nodes);
      if (!items.length) {
        return;
      }
      await withProgress(
        vscode.l10n.t('Stopping {0}...', names(items)),
        async () => {
          for (const m of items) {
            await cli.run(['machine', 'stop', m.id]);
          }
        },
      );
      refresh();
    },
  );

  register(
    ctx,
    'appleContainer.machine.restart',
    async (node?: MachineNode, nodes?: MachineNode[]) => {
      const items = selection(node, nodes);
      if (!items.length) {
        return;
      }
      await withProgress(
        vscode.l10n.t('Restarting {0}...', names(items)),
        async () => {
          for (const m of items) {
            await restart(ctx, m.id);
          }
        },
      );
      refresh();
    },
  );

  register(ctx, 'appleContainer.machine.edit', async (node?: MachineNode) => {
    if (node) {
      await editMachine(ctx, node.resource);
    }
  });

  register(
    ctx,
    'appleContainer.machine.setDefault',
    async (node?: MachineNode) => {
      if (node) {
        await cli.run(['machine', 'set-default', node.resource.id]);
        refresh();
      }
    },
  );

  register(
    ctx,
    'appleContainer.machine.inspect',
    async (node?: MachineNode) => {
      if (node) {
        const id = node.resource.id;
        await ctx.documents.open(`/machine/${id}.json`, async () => {
          const out = await cli.run(['machine', 'inspect', id]);
          try {
            return JSON.stringify(JSON.parse(out), null, 2);
          } catch {
            return out;
          }
        });
      }
    },
  );

  register(ctx, 'appleContainer.machine.logs', async (node?: MachineNode) => {
    if (node) {
      const tail = logTail();
      await openCliTerminal(cli, vscode.l10n.t('Logs: {0}', node.resource.id), [
        'machine',
        'logs',
        '--follow',
        ...(tail > 0 ? ['-n', String(tail)] : []),
        node.resource.id,
      ]);
    }
  });

  register(
    ctx,
    'appleContainer.machine.bootLogs',
    async (node?: MachineNode) => {
      if (node) {
        await openCliTerminal(
          cli,
          vscode.l10n.t('Boot Logs: {0}', node.resource.id),
          ['machine', 'logs', '--boot', node.resource.id],
        );
      }
    },
  );

  register(ctx, 'appleContainer.machine.copyIp', async (node?: MachineNode) => {
    if (node?.resource.ipv4) {
      await vscode.env.clipboard.writeText(node.resource.ipv4);
    }
  });

  register(
    ctx,
    'appleContainer.machine.delete',
    async (node?: MachineNode, nodes?: MachineNode[]) => {
      const items = selection(node, nodes);
      if (!items.length) {
        return;
      }
      const list = names(items);
      if (
        !(await confirm(
          vscode.l10n.t('Delete machine {0}?', list),
          vscode.l10n.t('Delete'),
          vscode.l10n.t(
            'The machine and its persistent storage will be permanently deleted. Files in your home directory on this Mac are kept.',
          ),
        ))
      ) {
        return;
      }
      await withProgress(vscode.l10n.t('Deleting {0}...', list), async () => {
        for (const m of items) {
          await cli.run(['machine', 'delete', m.id]);
        }
      });
      refresh();
    },
  );
}

function names(items: MachineSummary[]): string {
  return items.map(m => m.id).join(', ');
}

/**
 * An interactive login shell in the machine; `machine run` boots it first if needed and starts in the same folder as
 * the terminal when that is under the home directory.
 */
async function openMachineShell(
  ctx: CommandContext,
  id: string,
  root: boolean,
): Promise<void> {
  await openCliTerminal(ctx.cli, root ? vscode.l10n.t('{0} (root)', id) : id, [
    'machine',
    'run',
    '--name',
    id,
    ...(root ? ['--root'] : []),
  ]);
  ctx.views.machines.refresh();
}

async function restart(ctx: CommandContext, id: string): Promise<void> {
  await ctx.cli.run(['machine', 'stop', id]);
  await ctx.cli.run(machineStartArgs(id), {timeoutMs: BOOT_TIMEOUT_MS});
}

interface ImagePick extends vscode.QuickPickItem {
  reference: string;
}

/** Local images to pick from; typing a reference offers it as the first item, to be pulled by `machine create` */
async function pickMachineImage(
  ctx: CommandContext,
  title: string,
): Promise<string | undefined> {
  const images = await ctx.cli.listImages().catch(() => []);
  const local: ImagePick[] = images.map(i => ({
    label: i.displayName,
    description: i.reference,
    reference: i.reference,
  }));
  const qp = vscode.window.createQuickPick<ImagePick>();
  qp.title = title;
  qp.placeholder = vscode.l10n.t(
    'Image with /sbin/init, e.g. alpine:latest; type a reference to pull it',
  );
  qp.ignoreFocusOut = true;
  qp.items = local;
  qp.onDidChangeValue(value => {
    const typed = value.trim();
    qp.items =
      typed && !local.some(i => i.label === typed || i.reference === typed)
        ? [
            {
              label: typed,
              description: vscode.l10n.t('Pull and use this image'),
              reference: typed,
              alwaysShow: true,
            },
            ...local,
          ]
        : local;
  });
  return new Promise(resolve => {
    let picked: string | undefined;
    qp.onDidAccept(() => {
      picked = qp.selectedItems[0]?.reference;
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve(picked);
    });
    qp.show();
  });
}

function insecureRegistries(): string[] {
  return vscode.workspace
    .getConfiguration('appleContainer')
    .get<string[]>('insecureRegistries', []);
}

function validateCpus(value: string): string | undefined {
  const cores = os.cpus().length;
  const n = Number(value.trim());
  return !value.trim() || (Number.isInteger(n) && n >= 1 && n <= cores)
    ? undefined
    : vscode.l10n.t(
        'CPUs must be a whole number from 1 to {0}, the cores of this Mac',
        String(cores),
      );
}

function validateMemory(value: string): string | undefined {
  return !value.trim() || isValidMemory(value)
    ? undefined
    : vscode.l10n.t('Use a size such as 8G or 1536M');
}

interface HomeMountPick extends vscode.QuickPickItem {
  value: HomeMount;
}

async function pickHomeMount(
  title: string,
  current?: string,
): Promise<HomeMount | undefined> {
  const items: HomeMountPick[] = [
    {
      value: 'rw',
      label: vscode.l10n.t('Read-write'),
      description: 'rw',
      detail: vscode.l10n.t(
        'Mount your Mac home directory at the same path, writable',
      ),
    },
    {
      value: 'ro',
      label: vscode.l10n.t('Read-only'),
      description: 'ro',
      detail: vscode.l10n.t(
        'Mount your Mac home directory at the same path, read-only',
      ),
    },
    {
      value: 'none',
      label: vscode.l10n.t('Not mounted'),
      description: 'none',
      detail: vscode.l10n.t('Keep your Mac home directory out of the machine'),
    },
  ];
  for (const item of items) {
    if (item.value === current) {
      item.picked = true;
      item.label = `$(check) ${item.label}`;
    }
  }
  const sorted = current
    ? [
        ...items.filter(i => i.value === current),
        ...items.filter(i => i.value !== current),
      ]
    : items;
  const picked = await vscode.window.showQuickPick(sorted, {
    title,
    placeHolder: vscode.l10n.t('Home directory'),
    ignoreFocusOut: true,
  });
  return picked?.value;
}

async function askCreateOptions(ctx: CommandContext) {
  const title = vscode.l10n.t('New Machine');
  const image = await pickMachineImage(ctx, title);
  if (!image) {
    return undefined;
  }
  const existing = await ctx.cli.listMachines().catch(() => []);
  const taken = new Set(existing.map(m => m.id));
  const name = await ask({
    title,
    prompt: vscode.l10n.t('Machine name'),
    value: defaultMachineName(image),
    validateInput: v => {
      const n = v.trim();
      if (!isValidMachineName(n)) {
        return vscode.l10n.t(
          'Use lowercase letters, digits and hyphens, starting and ending with a letter or digit',
        );
      }
      return taken.has(n)
        ? vscode.l10n.t('Machine {0} already exists', n)
        : undefined;
    },
  });
  if (!name) {
    return undefined;
  }
  const cpus = await ask({
    title,
    prompt: vscode.l10n.t('CPUs (optional)'),
    placeHolder: vscode.l10n.t(
      'Default: half of the cores of this Mac, at least 4',
    ),
    allowEmpty: true,
    validateInput: validateCpus,
  });
  if (cpus === undefined) {
    return undefined;
  }
  const memory = await ask({
    title,
    prompt: vscode.l10n.t('Memory (optional), e.g. 8G'),
    placeHolder: vscode.l10n.t('Default: half of the memory of this Mac'),
    allowEmpty: true,
    validateInput: validateMemory,
  });
  if (memory === undefined) {
    return undefined;
  }
  const homeMount = await pickHomeMount(title, 'rw');
  if (!homeMount) {
    return undefined;
  }
  // The first machine becomes the default anyway
  let setDefault = false;
  if (existing.length) {
    const yes = vscode.l10n.t('Yes');
    const answer = await vscode.window.showQuickPick(
      [yes, vscode.l10n.t('No')],
      {
        title,
        placeHolder: vscode.l10n.t(
          'Make {0} the default machine of `container machine run`?',
          name,
        ),
        ignoreFocusOut: true,
      },
    );
    if (!answer) {
      return undefined;
    }
    setDefault = answer === yes;
  }
  return {
    image,
    name,
    cpus: cpus ? Number(cpus) : undefined,
    memory: memory || undefined,
    homeMount: homeMount === 'rw' ? undefined : homeMount,
    setDefault,
    registryArgs: schemeArgs(image, insecureRegistries()),
  };
}

/** `machine set` with the CPUs, memory and home mount; they apply on the next boot, so a running machine may restart */
async function editMachine(
  ctx: CommandContext,
  machine: MachineSummary,
): Promise<void> {
  const {cli} = ctx;
  const id = machine.id;
  const details = await cli.inspectMachine(id);
  const title = vscode.l10n.t('Edit Machine {0}', id);
  const currentCpus = details?.cpus ?? machine.cpus;
  const currentMemory =
    (details?.memoryBytes ?? machine.memoryBytes) !== undefined
      ? memoryValue((details?.memoryBytes ?? machine.memoryBytes)!)
      : undefined;
  const cpus = await ask({
    title,
    prompt: vscode.l10n.t('CPUs'),
    value: currentCpus !== undefined ? String(currentCpus) : '',
    allowEmpty: true,
    validateInput: validateCpus,
  });
  if (cpus === undefined) {
    return;
  }
  const memory = await ask({
    title,
    prompt: vscode.l10n.t('Memory, e.g. 8G'),
    value: currentMemory ?? '',
    allowEmpty: true,
    validateInput: validateMemory,
  });
  if (memory === undefined) {
    return;
  }
  const homeMount = await pickHomeMount(title, details?.homeMount);
  if (!homeMount) {
    return;
  }
  const args = machineSetArgs(id, {
    cpus: cpus && Number(cpus) !== currentCpus ? Number(cpus) : undefined,
    memory:
      memory && memory.toUpperCase() !== currentMemory?.toUpperCase()
        ? memory
        : undefined,
    homeMount: homeMount !== details?.homeMount ? homeMount : undefined,
  });
  if (!args) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Machine {0} is unchanged.', id),
    );
    return;
  }
  await cli.run(args);
  ctx.views.machines.refresh();
  if (machine.status !== 'running') {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('The new settings of {0} apply when it starts.', id),
    );
    return;
  }
  const restartNow = vscode.l10n.t('Restart');
  const answer = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'The new settings of {0} apply when it restarts. Restart it now?',
      id,
    ),
    restartNow,
  );
  if (answer === restartNow) {
    await withProgress(vscode.l10n.t('Restarting {0}...', id), () =>
      restart(ctx, id),
    );
    ctx.views.machines.refresh();
  }
}
