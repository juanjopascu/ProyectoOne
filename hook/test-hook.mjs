#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.join(__dirname, 'agy-notify-hook.mjs');

const samplePayload = {
  hookEventName: 'PreToolUse',
  conversationId: 'test-conv-001',
  cwd: process.cwd(),
  workspacePaths: [process.cwd()],
  lastUserInput: 'Ejecutar prueba de notificación push al teléfono',
  stepIdx: 1,
  toolCall: {
    id: 'toolu_test_01',
    name: 'run_command',
    args: {
      CommandLine: 'echo "Hola desde Antigravity IDE!" && git status',
      toolSummary: 'Prueba de aprobación remota'
    }
  }
};

console.log('⏳ Enviando solicitud de prueba al Antigravity Bridge...');
console.log('📱 Revisa tu teléfono o http://localhost:4789 para Aprobar o Rechazar.');

const child = spawn(process.execPath, [hookScript], { stdio: ['pipe', 'pipe', 'inherit'] });
let stdout = '';

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
});

child.on('close', (code) => {
  console.log(`\n✅ Hook finalizado (exit ${code}):`);
  console.log(stdout);
});

child.stdin.write(JSON.stringify(samplePayload));
child.stdin.end();
