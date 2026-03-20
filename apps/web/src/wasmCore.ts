import type { WasmRuleInput, WasmRuleResult } from "@amida/protocol";

export type WasmHostDecider = {
  validateSkill(input: WasmRuleInput): WasmRuleResult;
};

type WasmModule = {
  default?: (input?: unknown) => Promise<unknown>;
  init?: (input?: unknown) => Promise<unknown>;
  validate_skill?: (input: unknown) => unknown;
};

export async function loadWasmCore(): Promise<WasmHostDecider | null> {
  try {
    const wasmPath = "../../../crates/ladder-core/pkg/ladder_core.js";
    const dynamicImport = new Function("p", "return import(p)") as (p: string) => Promise<unknown>;
    const mod = (await dynamicImport(wasmPath)) as WasmModule;

    if (typeof mod.default === "function") {
      await mod.default();
    } else if (typeof mod.init === "function") {
      await mod.init();
    }

    if (typeof mod.validate_skill !== "function") {
      console.warn("WASM loaded but validate_skill not found");
      return null;
    }

    return {
      validateSkill(input: WasmRuleInput): WasmRuleResult {
        return mod.validate_skill?.(input) as WasmRuleResult;
      },
    };
  } catch (err) {
    console.warn("WASM decider unavailable. Fallback to TS host logic.", err);
    return null;
  }
}
