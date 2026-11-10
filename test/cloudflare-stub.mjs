// Just enough of "cloudflare:workers" for the tests: the real thing only exists inside Cloudflare.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

globalThis.WebSocketRequestResponsePair ??= class {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
};
