/** Whether a provider answered its recent probes. A provider with no record counts as `up`. */
export const PROVIDER_STATES = ['up', 'down'] as const;

export type ProviderState = (typeof PROVIDER_STATES)[number];

/** The scope of a provider's health across every country, as opposed to one ISO country code. */
export const GLOBAL_SCOPE = 'global';

/** How many times the time between two probes of a group its stored health stays valid. */
export const STALE_ROUNDS = 3;
