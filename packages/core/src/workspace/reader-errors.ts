import type { FileProblem } from "@tryaura/aura-sdk";

import { errorCode } from "../values.js";

export function isAbsence(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export function toProblem(error: unknown): FileProblem {
  switch (errorCode(error)) {
    case "EACCES":
    case "EPERM": {
      return "denied";
    }
    case "ELOOP": {
      return "loop";
    }
    case "EMFILE":
    case "ENFILE":
    case "ENOMEM": {
      return "resources";
    }
    case "EISDIR":
    case "ENXIO": {
      return "unsupported";
    }
    default: {
      return "unreadable";
    }
  }
}
