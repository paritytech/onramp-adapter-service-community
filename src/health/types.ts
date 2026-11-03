/** Whether a provider answered its recent probes. A provider with no record counts as `up`. */
export const PROVIDER_STATES = ['up', 'down'] as const;

export type ProviderState = (typeof PROVIDER_STATES)[number];

/** The scope of a provider's health across every country, as opposed to one ISO country code. */
export const GLOBAL_SCOPE = 'global';
