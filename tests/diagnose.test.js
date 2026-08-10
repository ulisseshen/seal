// Tests for the omission-diagnosis engine (src/brain/diagnose.js).
//
// The rule (TL-approved): never assert the future; every risk traces to facts;
// no signal → no diagnosis (silence, not a false alarm). These tests pin that.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP_DB = path.join(os.tmpdir(), `seal-diagnose-test-${process.pid}-${Date.now()}.db`);
process.env.SEAL_DB_PATH = TMP_DB;

const db = await import('../src/db.js');
const { insertTask } = db;
const { diagnosePerson, diagnoseTeam, collectFacts } = await import('../src/brain/diagnose.js');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
});

let seq = 0;
function note(person, { detail = '', status = 'pending', execute_at = null } = {}) {
  return {
    id: `d${++seq}`,
    type: 'person',
    summary: `${person}: nota ${seq}`,
    detail,
    execute_at,
    recurrence: null,
    next_run: execute_at,
    prompt: null,
    project: null,
    allowed_tools: '[]',
    permission_mode: 'auto',
    capabilities: '[]',
    notify_type: 'sound',
    notify_channel: 'system',
    notify_target: null,
    people: JSON.stringify([person]),
    priority: 'medium',
    status,
    created: new Date().toISOString(),
    max_runs: null,
  };
}

test('person with no signals → level ok, zero risks (honest silence)', async () => {
  await insertTask(note('Calmo', { detail: 'OBSERVED: nada demais' }));
  const d = await diagnosePerson('Calmo');
  assert.equal(d.level, 'ok');
  assert.equal(d.risks.length, 0);
});

test('open sensitive signal + no 1:1 → critico, with traceable facts', async () => {
  await insertTask(note('Sensivel', { detail: 'CONTEXT: sinal sensivel, burnout', status: 'done' }));
  const d = await diagnosePerson('Sensivel');
  assert.equal(d.level, 'critico');
  const r = d.risks.find((x) => /desengajamento/i.test(x.risk));
  assert.ok(r, 'should flag desengajamento risk');
  // Every risk must carry its supporting facts — the honesty rule.
  assert.ok(r.because.length > 0);
  assert.ok(r.because.some((b) => /sens[ií]vel/i.test(b)));
});

test('sensitive signal counts even when status=done (permanent fact, not a task)', async () => {
  await insertTask(note('Burnt', { detail: 'CONTEXT: sensivel burnout', status: 'done' }));
  const facts = await collectFacts('Burnt');
  assert.equal(facts.sensitiveOpen.length, 1, 'done sensitive note must still register');
});

test('4+ open pendings → atrito risk', async () => {
  for (let i = 0; i < 4; i++) await insertTask(note('Cheio', { detail: 'OBSERVED: x' }));
  const d = await diagnosePerson('Cheio');
  assert.ok(d.risks.some((r) => /atrito/i.test(r.risk)));
  assert.ok(d.level === 'atencao' || d.level === 'critico');
});

test('badly overdue follow-up → erosão de confiança', async () => {
  await insertTask(note('Atrasado', { detail: 'OBSERVED: prometido', execute_at: '2020-01-01T00:00:00.000Z' }));
  const d = await diagnosePerson('Atrasado');
  const r = d.risks.find((x) => /confian/i.test(x.risk));
  assert.ok(r, 'should flag erosão de confiança');
  assert.ok(r.because.some((b) => /vencido h[aá]/i.test(b)));
});

test('diagnoseTeam: sorts critico before ok', async () => {
  await insertTask(note('TeamSens', { detail: 'CONTEXT: sensivel', status: 'done' }));
  await insertTask(note('TeamCalmo', { detail: 'OBSERVED: tranquilo' }));
  const team = await diagnoseTeam();
  const idxSens = team.findIndex((d) => d.person === 'TeamSens');
  const idxCalmo = team.findIndex((d) => d.person === 'TeamCalmo');
  assert.ok(idxSens >= 0 && idxCalmo >= 0);
  assert.ok(idxSens < idxCalmo, 'critico must sort before ok');
});

test('no risk ever lacks its facts (honesty invariant across whole team)', async () => {
  const team = await diagnoseTeam();
  for (const d of team) {
    for (const r of d.risks) {
      assert.ok(Array.isArray(r.because) && r.because.length > 0,
        `risk "${r.risk}" for ${d.person} has no supporting facts`);
    }
  }
});
