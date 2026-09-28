// Deepgram Aura-2 English voices (GET /v1/models, 2026-09-28), for the reply-voice picker (#255).
// Any Aura id the API accepts works; this list only names them. Refresh it from /v1/models when Deepgram
// adds voices.

/** Owner's pick (#255); the api has the same default. */
export const DEFAULT_TTS_VOICE = "aura-2-hermes-en";

export interface TtsVoice {
  id: string;
  name: string;
  accent: string;
  gender: "female" | "male" | "";
}

export const TTS_VOICES: TtsVoice[] = [
  { id: "aura-2-amalthea-en", name: "Amalthea", accent: "Filipino", gender: "female" },
  { id: "aura-2-andromeda-en", name: "Andromeda", accent: "American", gender: "female" },
  { id: "aura-2-apollo-en", name: "Apollo", accent: "American", gender: "male" },
  { id: "aura-2-arcas-en", name: "Arcas", accent: "American", gender: "male" },
  { id: "aura-2-aries-en", name: "Aries", accent: "American", gender: "male" },
  { id: "aura-2-asteria-en", name: "Asteria", accent: "American", gender: "female" },
  { id: "aura-2-athena-en", name: "Athena", accent: "American", gender: "female" },
  { id: "aura-2-atlas-en", name: "Atlas", accent: "American", gender: "male" },
  { id: "aura-2-aurora-en", name: "Aurora", accent: "American", gender: "female" },
  { id: "aura-2-callista-en", name: "Callista", accent: "American", gender: "female" },
  { id: "aura-2-cora-en", name: "Cora", accent: "American", gender: "female" },
  { id: "aura-2-cordelia-en", name: "Cordelia", accent: "American", gender: "female" },
  { id: "aura-2-delia-en", name: "Delia", accent: "American", gender: "female" },
  { id: "aura-2-draco-en", name: "Draco", accent: "British", gender: "male" },
  { id: "aura-2-electra-en", name: "Electra", accent: "American", gender: "female" },
  { id: "aura-2-harmonia-en", name: "Harmonia", accent: "American", gender: "female" },
  { id: "aura-2-helena-en", name: "Helena", accent: "American", gender: "female" },
  { id: "aura-2-hera-en", name: "Hera", accent: "American", gender: "female" },
  { id: "aura-2-hermes-en", name: "Hermes", accent: "American", gender: "male" },
  { id: "aura-2-hyperion-en", name: "Hyperion", accent: "Australian", gender: "male" },
  { id: "aura-2-iris-en", name: "Iris", accent: "American", gender: "female" },
  { id: "aura-2-janus-en", name: "Janus", accent: "American", gender: "female" },
  { id: "aura-2-juno-en", name: "Juno", accent: "American", gender: "female" },
  { id: "aura-2-jupiter-en", name: "Jupiter", accent: "American", gender: "male" },
  { id: "aura-2-luna-en", name: "Luna", accent: "American", gender: "female" },
  { id: "aura-2-mars-en", name: "Mars", accent: "American", gender: "male" },
  { id: "aura-2-minerva-en", name: "Minerva", accent: "American", gender: "female" },
  { id: "aura-2-neptune-en", name: "Neptune", accent: "American", gender: "male" },
  { id: "aura-2-odysseus-en", name: "Odysseus", accent: "American", gender: "male" },
  { id: "aura-2-ophelia-en", name: "Ophelia", accent: "American", gender: "female" },
  { id: "aura-2-orion-en", name: "Orion", accent: "American", gender: "male" },
  { id: "aura-2-orpheus-en", name: "Orpheus", accent: "American", gender: "male" },
  { id: "aura-2-pandora-en", name: "Pandora", accent: "British", gender: "female" },
  { id: "aura-2-phoebe-en", name: "Phoebe", accent: "American", gender: "female" },
  { id: "aura-2-pluto-en", name: "Pluto", accent: "American", gender: "male" },
  { id: "aura-2-saturn-en", name: "Saturn", accent: "American", gender: "male" },
  { id: "aura-2-selene-en", name: "Selene", accent: "American", gender: "female" },
  { id: "aura-2-thalia-en", name: "Thalia", accent: "American", gender: "female" },
  { id: "aura-2-theia-en", name: "Theia", accent: "Australian", gender: "female" },
  { id: "aura-2-vesta-en", name: "Vesta", accent: "American", gender: "female" },
  { id: "aura-2-zeus-en", name: "Zeus", accent: "American", gender: "male" },
];
