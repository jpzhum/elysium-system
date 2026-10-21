import assert from "node:assert/strict";
import { test } from "vitest";
import { TranscriptWakeGate, containsWakeWord } from "../src/audio/wakeword.js";

test("wake transcript gate accepts PT-BR spelling variants and punctuation", () => {
  const gate = new TranscriptWakeGate();
  for (const input of ["Jarvis, me ajuda?", "JÁRVIS!", "Ei, Djárvis.", "fale com o Járvis"]) {
    assert.equal(gate.containsWakeWord(input), true);
  }
});

test("wake transcript gate requires an entire word and does not activate arbitrary speech", () => {
  for (const input of ["vamos pela esquerda", "jarvisão", "antiJarvis", "Jarvis123", "", "jardim"]) {
    assert.equal(containsWakeWord(input), false);
  }
  assert.equal(containsWakeWord("Jarvis", ""), false);
  assert.equal(containsWakeWord("Olá, Alfred!", "Alfred"), true);
});
