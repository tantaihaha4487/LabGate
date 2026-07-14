import { validateRuntimeConfiguration } from "@/lib/config";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      validateRuntimeConfiguration();
    } catch (error: unknown) {
      console.error("LabGate runtime configuration is invalid.", error);
      process.exit(1);
    }
  }
}
