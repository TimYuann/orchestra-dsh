import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTeam, transferOrchestrationControl } from '../lib/orchestra-state.js';

function rawTeam(role) {
  return {
    schemaVersion: 1,
    teamId: 'team-regression',
    status: 'active',
    rootCwd: '/tmp/regression',
    controllerSessionId: 'driver-A',
    controllerHistory: [],
    topologyRef: { id: 'hybrid', source: 'bundled' },
    mission: { objective: 'regression', scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: '' },
    createdAt: 1,
    activatedFromArchiveId: null,
    roles: [role],
    reports: [],
  };
}

function child(overrides = {}) {
  return {
    id: 'scout', name: 'Scout', sessionId: 'child-1', phase: 'reserved', execution: 'subagent',
    parentSessionId: 'driver-A', persona: 'ONLY EVIDENCE',
    toolFilter: { allow: ['read'], deny: ['bash'] }, sessionHistory: [], preset: null,
    sandbox: 'read-only', reportCount: 0, lastReport: null, ...overrides,
  };
}

test('#2 normalize preserves cloned subagent persona/toolFilter across the durable read boundary', () => {
  const source = rawTeam(child());
  const normalized = normalizeTeam(source, '/tmp/regression');
  assert.ok(normalized);
  const role = normalized.roles[0];
  assert.equal(role.persona, 'ONLY EVIDENCE');
  assert.deepEqual(role.toolFilter, { allow: ['read'], deny: ['bash'] });
  assert.notEqual(role.toolFilter, source.roles[0].toolFilter, 'normalization must not retain a caller-owned mutable object');
  assert.notEqual(role.toolFilter.allow, source.roles[0].toolFilter.allow);
  assert.notEqual(role.toolFilter.deny, source.roles[0].toolFilter.deny);
});

test('#5 takeover replaces a materialized child identity instead of reusing a durable child id', () => {
  const original = rawTeam(child({ phase: 'active', welcome: { messageId: 'm1', sessionId: 'child-1', acceptedAt: 2 } }));
  const transferred = transferOrchestrationControl(original, 'driver-B', { reason: 're-entry-continue', timestamp: 99 });
  const role = transferred.roles[0];
  assert.equal(role.phase, 'reserved');
  assert.equal(role.parentSessionId, 'driver-B');
  assert.equal(role.welcome, undefined);
  assert.notEqual(role.sessionId, 'child-1', 'native startContinuable would reject the persisted old id as DUPLICATE_CHILD');
  assert.equal(role.sessionHistory.length, 1);
  assert.equal(role.sessionHistory[0].sessionId, 'child-1');
  assert.equal(role.sessionHistory[0].replacedAt, 99);
  assert.match(role.sessionHistory[0].reason, /takeover|re-entry/i);
});

test('#5 takeover keeps the identity only for a genuinely never-materialized reserved seat', () => {
  const original = rawTeam(child({ phase: 'reserved', welcome: undefined }));
  const transferred = transferOrchestrationControl(original, 'driver-B', { reason: 're-entry-continue', timestamp: 99 });
  const role = transferred.roles[0];
  assert.equal(role.sessionId, 'child-1');
  assert.deepEqual(role.sessionHistory, []);
  assert.equal(role.parentSessionId, 'driver-B');
});
