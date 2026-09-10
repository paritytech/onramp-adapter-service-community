/**
 * The single import of the verifiable crate's wasm bindings, isolated here.
 *
 * `verifiablejs/nodejs` is CommonJS (wasm-pack `--target nodejs`), so under this repo's
 * `verbatimModuleSyntax`/NodeNext it comes in as the default export. `validate_with_commitment`
 * verifies a ring-VRF proof against a `Members.Root` commitment, the same check
 * `pallet-members::verify_membership` performs on chain.
 *
 * The version is pinned exactly rather than caret-ranged, because this module decides who is a
 * person and "whatever npm resolves below 2.0.0" is not a version policy.
 */
import v from 'verifiablejs/nodejs';
import type { Validate } from './register.js';

/** The real ring-VRF verifier, bound once. Every other personhood path takes this as a port. */
export const validateWithCommitment: Validate = v.validate_with_commitment;
