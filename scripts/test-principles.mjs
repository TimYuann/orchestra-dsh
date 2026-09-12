/**
 * The orchestration method must actually reach the driver.
 *
 * These principles are the plugin's product — a graph is only what the method
 * produces — so "it is written down in the repository" is not the same as "a
 * driver reads it". The assertions below pin the two delivery surfaces and, just
 * as importantly, the degradation: a deployment composing no skill registry
 * keeps the always-on rules instead of silently losing its discipline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRINCIPLES_SECTION_NAME,
  PRINCIPLES_SECTION_TEXT,
  PRINCIPLES_SKILL_CONTENT,
  PRINCIPLES_SKILL_NAME,
  registerOrchestrationPrinciples,
} from "../lib/orchestration-principles.js";

function fakeContext(options = {}) {
  const sections = [];
  const skills = [];
  const explicit = {
    get(name) {
      if (name === "systemPrompt") return options.noPrompt === true ? undefined : { section: (entry) => sections.push(entry) };
      if (name === "skills") return options.noSkills === true ? undefined : { register: (entry) => skills.push(entry) };
      return undefined;
    },
  };
  return { ctx: explicit, sections, skills };
}

test("the principles reach the driver on both surfaces", () => {
  const runtime = fakeContext();
  const result = registerOrchestrationPrinciples(runtime.ctx);
  assert.deepEqual(result, { skill: true });

  assert.equal(runtime.sections.length, 1);
  const section = runtime.sections[0];
  assert.equal(section.name, PRINCIPLES_SECTION_NAME);
  assert.equal(section.text, PRINCIPLES_SECTION_TEXT);
  // The always-on half must stay small: it is paid for on every request of
  // every session, so it carries decisions rather than their reasoning.
  assert.ok(section.text.length < 3000, `always-on principles section is ${section.text.length} chars`);
  for (const rule of ["GRAPH", "NODES", "BACKEND", "EDGES", "AUTHORITY", "UNATTENDED"]) {
    assert.ok(section.text.includes(rule), `the section must state the ${rule} rule`);
  }
  // The one rule whose violation is a safety bug rather than a style problem.
  assert.match(section.text, /toolFilter narrows availability and is NOT a permission guarantee/);

  assert.equal(runtime.skills.length, 1);
  const skill = runtime.skills[0];
  assert.equal(skill.name, PRINCIPLES_SKILL_NAME);
  assert.equal(skill.source, "runtime");
  assert.ok(skill.description.length > 40 && skill.whenToUse.length > 40, "routing metadata is what gets the skill loaded");
  assert.ok(skill.content.includes(PRINCIPLES_SKILL_CONTENT));
  // The skill is the elaborated half: it carries the checklist and the why.
  assert.match(skill.content, /## Checking the graph before you propose/);
  assert.match(skill.content, /joins the driver's LIVE Agent Preset/);
  assert.ok(skill.content.length > section.text.length, "the skill must carry more than the section");
});

test("a deployment without a skill registry keeps the rules, not silence", () => {
  const runtime = fakeContext({ noSkills: true });
  assert.deepEqual(registerOrchestrationPrinciples(runtime.ctx), { skill: false });
  assert.equal(runtime.skills.length, 0);
  // The discipline itself is still installed; only the elaboration is absent.
  assert.equal(runtime.sections.length, 1);
  assert.equal(runtime.sections[0].text, PRINCIPLES_SECTION_TEXT);
});
