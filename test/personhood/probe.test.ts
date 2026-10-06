import { describe, expect, it } from 'vitest';

import { probePersonhoodNetworks } from '../../src/startup.js';
import type { PersonhoodNetwork } from '../../src/personhood.js';

const COMMITMENT = '0x' + '11'.repeat(768);
const IDENTIFIER = '0x' + '22'.repeat(32);
const LITE = '0x' + '33'.repeat(32);

/** `null` is a collection the chain serves nothing for; an `Error` is a read that failed. */
function network(
  id: string,
  roots: Record<string, string | null | Error>,
  identifiers: string[] = Object.keys(roots),
): PersonhoodNetwork {
  return {
    id,
    commitments: {
      commitment: async (identifier: string) => {
        const answer = roots[identifier];
        if (answer instanceof Error) throw answer;
        return answer ?? null;
      },
    },
    rings: identifiers.map((identifier) => ({ identifier, exponent: 9 })),
  };
}

const silent = () => {
  /* the probe's log is asserted only where a test is about it */
};

/** Which misconfigurations are worth refusing a boot for, and which are not. */
describe('probePersonhoodNetworks', () => {
  it('accepts a network whose collection has a root', async () => {
    await expect(
      probePersonhoodNetworks([network('previewnet', { [IDENTIFIER]: COMMITMENT })], silent),
    ).resolves.toBeUndefined();
  });

  it('accepts a network where only one of its collections has a root', async () => {
    // The live shape on previewnet and polkadot-test. Requiring every collection to answer would
    // refuse the deployment this repo runs.
    await expect(
      probePersonhoodNetworks(
        [network('previewnet', { [LITE]: COMMITMENT, [IDENTIFIER]: null })],
        silent,
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a boot when a reachable network answers for none of its collections', async () => {
    // Reachable and empty is a wrong chain or a wrong identifier, not an outage.
    await expect(
      probePersonhoodNetworks([network('polkadot-test', { [IDENTIFIER]: null })], silent),
    ).rejects.toThrow(/'polkadot-test' answered for none of their configured collections/);
  });

  it('names every dead network, not just the first, so one boot fixes them all', async () => {
    await expect(
      probePersonhoodNetworks(
        [
          network('previewnet', { [IDENTIFIER]: null }),
          network('paseo-next-v2', { [IDENTIFIER]: COMMITMENT }),
          network('polkadot-test', { [IDENTIFIER]: null }),
        ],
        silent,
      ),
    ).rejects.toThrow(/'previewnet', 'polkadot-test'/);
  });

  it('lets an unreachable network through, because an outage is not a verdict', async () => {
    // Treating a failed read as "wrong chain" would turn a blip into a restart loop. Its redeems
    // fail as 503 until it answers, which is loud enough.
    const logged: string[] = [];
    await expect(
      probePersonhoodNetworks(
        [network('previewnet', { [IDENTIFIER]: new Error('socket hang up') })],
        (m) => logged.push(m),
      ),
    ).resolves.toBeUndefined();
    expect(logged.join('\n')).toMatch(/'previewnet' could not be fully read/);
  });

  it('lets through a network that answered None on one collection and errored on another', async () => {
    // The live shape on previewnet and polkadot-test: `people` has no root, `people-lite` does. A
    // `people-lite` timeout at boot must not read as a wrong chain, or one slow read refuses the
    // whole service, healthy networks included.
    const logged: string[] = [];
    await expect(
      probePersonhoodNetworks(
        [
          network('previewnet', { [LITE]: new Error('timeout'), [IDENTIFIER]: null }),
          network('paseo-next-v2', { [LITE]: COMMITMENT }),
        ],
        (m) => logged.push(m),
      ),
    ).resolves.toBeUndefined();
    expect(logged.join('\n')).toMatch(/'previewnet' could not be fully read/);
  });

  it('still refuses a dead network beside an unverified one', async () => {
    await expect(
      probePersonhoodNetworks(
        [
          network('previewnet', { [LITE]: new Error('timeout'), [IDENTIFIER]: null }),
          network('polkadot-test', { [LITE]: null, [IDENTIFIER]: null }),
        ],
        silent,
      ),
    ).rejects.toThrow(/^auth\.personhood\.networks 'polkadot-test' answered/);
  });

  it('probes networks in parallel, so one slow chain does not delay the others', async () => {
    // The first network's read settles only once the second network has been asked. Probed in
    // sequence, this never resolves.
    let release: () => void = () => undefined;
    const secondAsked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: PersonhoodNetwork = {
      id: 'previewnet',
      commitments: {
        commitment: async () => {
          await secondAsked;
          return COMMITMENT;
        },
      },
      rings: [{ identifier: LITE, exponent: 9 }],
    };
    const fast: PersonhoodNetwork = {
      id: 'paseo-next-v2',
      commitments: {
        commitment: async () => {
          release();
          return COMMITMENT;
        },
      },
      rings: [{ identifier: LITE, exponent: 9 }],
    };

    await expect(probePersonhoodNetworks([slow, fast], silent)).resolves.toBeUndefined();
  });

  it('stops reading a network as soon as one collection answers', async () => {
    const asked: string[] = [];
    const probe: PersonhoodNetwork = {
      id: 'previewnet',
      commitments: {
        commitment: async (identifier: string) => {
          asked.push(identifier);
          return COMMITMENT;
        },
      },
      rings: [LITE, IDENTIFIER].map((identifier) => ({ identifier, exponent: 9 })),
    };

    await probePersonhoodNetworks([probe], silent);
    expect(asked).toEqual([LITE]);
  });

  it('accepts an empty list, which is what `insecure_dev` reaches this with', async () => {
    await expect(probePersonhoodNetworks([], silent)).resolves.toBeUndefined();
  });
});
