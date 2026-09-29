// jsdom ships no types and the tests only need to evaluate scripts in a page,
// so this declares just that surface instead of pulling in @types/jsdom.
declare module "jsdom" {
  export class JSDOM {
    constructor(
      html?: string,
      options?: { readonly url?: string; readonly runScripts?: "dangerously" | "outside-only" },
    );
    readonly window: { readonly eval: (code: string) => unknown };
  }
}
