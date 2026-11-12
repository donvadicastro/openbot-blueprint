#!/usr/bin/env node
import { dirname } from 'node:path';
import { catalog, load, checked, scaffold, exportOpenBot, validate, errorMessage } from '../src/blueprints.js';
import { provisionOpenBot } from './openbot-compose.js';
import type { Blueprint } from '../src/types.js';

const help = `Project blueprint catalog

  list                                     List available project types
  show <id|file>                           Show roster and workflow
  validate [id|file]                        Validate one blueprint or the catalog
  scaffold <source> <directory> <new-id>     Create a project from a blueprint
  export-openbot <id|file> <directory> [--include-optional]
  provision <id|file> --env-file <path> [--app-port <port>] [--state-dir <path>]

Run with: npm run blueprint -- <command>
Catalog/export outputs must be new directories. Provision validates local credentials and starts Docker Compose.`;

async function main(args: string[]) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help') { console.log(help); return; }
  if (command === 'provision') {
    const [source, ...flags] = rest;
    if (!source || flags.length % 2) throw new Error(`Invalid provision arguments.\n${help}`);
    const values = new Map<string, string>();
    for (let i = 0; i < flags.length; i += 2) {
      if (!['--env-file', '--app-port', '--state-dir'].includes(flags[i]) || values.has(flags[i])) throw new Error(`Invalid provision option ${flags[i]}`);
      values.set(flags[i], flags[i + 1]);
    }
    const envFile = values.get('--env-file');
    if (!envFile) throw new Error('Provision requires --env-file');
    const result = await provisionOpenBot(source, {
      envFile, appPort: values.has('--app-port') ? Number(values.get('--app-port')) : undefined,
      stateDirectory: values.get('--state-dir'),
    });
    console.log(`${result.existing ? 'Existing' : 'Provisioned'} installation ${result.binding.composeProject} (${result.binding.state}) at http://localhost:${result.binding.appPort}`);
    return;
  }
  const counts: Record<string, number[]> = { list: [0], show: [1], validate: [0, 1], scaffold: [3], 'export-openbot': [2, 3] };
  if (!counts[command]?.includes(rest.length)) throw new Error(`Invalid command or arguments.\n${help}`);
  if (command === 'list') {
    for (const id of await catalog()) {
      const { blueprint: b } = await checked(id);
      console.log(`${b.id}@${b.version} — ${b.description}`);
    }
  } else if (command === 'show') {
    const { blueprint: b } = await checked(rest[0]);
    console.log(`${b.name} (${b.id}@${b.version})\n${b.description}\n\nAgents:`);
    for (const a of b.agents) {
      const runtime = a.runtime?.kind === 'local' ? `${a.runtime.language}/${a.runtime.framework}` : a.runtime?.kind ?? 'builtin';
      console.log(`  ${a.tier.padEnd(8)} ${a.id} [${runtime}]: ${a.purpose}`);
    }
    console.log('\nWorkflow:');
    for (const step of b.workflow) console.log(`  ${step.id} [${step.owner}] after: ${step.dependsOn.join(', ') || 'request'}; gates: ${step.gates.join(', ')}`);
  } else if (command === 'validate') {
    const inputs = rest.length ? rest : await catalog();
    if (!inputs.length) throw new Error('Catalog is empty');
    let failed = false;
    for (const input of inputs) {
      try {
        const { blueprint: b, path } = await load(input);
        const errors = await validate(b, dirname(path));
        if (errors.length) { failed = true; console.error(`${input}:\n  ${errors.join('\n  ')}`); }
        else {
          const valid = b as Blueprint;
          console.log(`Valid: ${valid.id}@${valid.version}`);
        }
      } catch (error) { failed = true; console.error(`${input}: ${errorMessage(error)}`); }
    }
    if (failed) process.exitCode = 1;
  } else if (command === 'scaffold') {
    console.log(`Created: ${await scaffold(rest[0], rest[1], rest[2])}`);
  } else if (command === 'export-openbot') {
    if (rest[2] && rest[2] !== '--include-optional') throw new Error(`Unknown option ${rest[2]}`);
    console.log(`Exported: ${await exportOpenBot(rest[0], rest[1], Boolean(rest[2]))}\nRead INTEGRATION.md before deployment; orchestration and grants need runtime setup.`);
  }
}

main(process.argv.slice(2)).catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
