import { describe, expect, it } from "vitest";

import type { WizardLoadRequest } from "../wizard-types.js";
import { fakeCatalog, recordingIo, REMOTE_ENTRY, skillStepContext } from "./skills.test-support.js";
import { skillsStep } from "./skills.js";

describe("skillsStep loading", () => {
  it("announces every source that still needs a request before the picker opens", async () => {
    const requests: WizardLoadRequest[] = [];
    const scripted = recordingIo([]);
    const io = {
      ...scripted,
      load: async <T>(
        request: WizardLoadRequest,
        task: (update: (id: string, status: "active" | "complete") => void) => Promise<T>,
      ): Promise<T> => {
        requests.push(request);
        return task(() => undefined);
      },
    };
    const catalog = fakeCatalog({
      entries: [REMOTE_ENTRY],
      pendingSources: [{ id: "directory:acme", name: "Acme Skills" }],
    });

    await skillsStep.gather(skillStepContext(catalog), io);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.items).toEqual([{ id: "directory:acme", label: "Acme Skills" }]);
    expect(requests[0]?.prompt).toBe("Loading skill sources…");
  });

  it("asks for no loading frame when every listing is already memoized", async () => {
    const requests: WizardLoadRequest[] = [];
    const scripted = recordingIo([]);
    const io = {
      ...scripted,
      load: async <T>(
        request: WizardLoadRequest,
        task: (update: (id: string, status: "active" | "complete") => void) => Promise<T>,
      ): Promise<T> => {
        requests.push(request);
        return task(() => undefined);
      },
    };

    await skillsStep.gather(skillStepContext(fakeCatalog({ entries: [REMOTE_ENTRY] })), io);

    expect(requests[0]?.items).toEqual([]);
  });
});
