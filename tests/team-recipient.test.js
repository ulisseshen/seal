import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCheckinPeople, resolveTeamRecipient } from '../src/brain/team-recipient.js';

const members = [
  { email: 'ana.souza@empresa.com', name: 'Ana Souza' },
  { email: 'ana@freela.dev', name: 'Ana' },
  { email: 'bruno@note-01.local', name: 'Bruno Lima' },
  { email: 'bruno.lima@empresa.com', name: 'Bruno Lima Filho' },
  { email: 'carla.dias@empresa.com', name: 'Carla Dias' },
  { email: 'carla.reis@empresa.com', name: 'Carla Reis' },
  { email: 'Gustavo.melo@empresa.com', name: 'Gustavo Melo' },
];

test('a first name or nickname resolves to the registered email, preferring the domain most of the team uses', () => {
  assert.equal(resolveTeamRecipient('Ana', members), 'ana.souza@empresa.com');
  assert.equal(resolveTeamRecipient('bruno', members), 'bruno.lima@empresa.com');
  assert.equal(resolveTeamRecipient('Gus', members), 'Gustavo.melo@empresa.com');
});

test('an ambiguous, unknown or already-email recipient goes through as typed', () => {
  assert.equal(resolveTeamRecipient('Carla', members), 'Carla');
  assert.equal(resolveTeamRecipient('Zeca', members), 'Zeca');
  assert.equal(resolveTeamRecipient('zeca@outra.com', members), 'zeca@outra.com');
  assert.equal(resolveTeamRecipient('Ana', []), 'Ana');
});

test('the check-in list comes from the local team file, and no file means nobody', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-team-'));
  const file = path.join(dir, 'team.json');
  assert.deepEqual(readCheckinPeople(file), []);
  fs.writeFileSync(file, JSON.stringify({ checkin: ['Ana', 'Bruno'] }));
  assert.deepEqual(readCheckinPeople(file), ['Ana', 'Bruno']);
  fs.writeFileSync(file, '{ quebrado');
  assert.deepEqual(readCheckinPeople(file), []);
});
