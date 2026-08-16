import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Above the SDK's own 5s probe ceiling, which the default 5s test timeout exactly matched.
     *
     * Integration tests spawn real shim processes, so under a loaded machine a probe that is still
     * within its budget could lose the race with the test timeout and fail the suite at random.
     * The timeout being tested has to be shorter than the timeout doing the testing.
     */
    testTimeout: 20_000,
  },
});
