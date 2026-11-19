import { env } from '../../config/env.js';
import { MockOnrampAdapter, onrampAdapter as mockOnrampAdapter } from './mock-onramp-adapter.js';

let adapter;

/** Entry point to the configured fiat on-ramp adapter. */
export function onrampAdapter() {
  adapter ??= createOnrampAdapter();
  return adapter;
}

export function createOnrampAdapter(options = {}) {
  if ((options.kind ?? env.ONRAMP_ADAPTER) === 'mock' && Object.keys(options).length === 0) {
    return mockOnrampAdapter();
  }
  return new MockOnrampAdapter(options);
}

/** Tests and bootstrap can inject a configured on-ramp adapter instance. */
export function setOnrampAdapter(instance) {
  adapter = instance;
}
