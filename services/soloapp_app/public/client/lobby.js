export class Lobby {
  constructor(auth, network) {
    this.auth = auth;
    this.network = network;
    this.reset();
  }
  reset() {
    this.current = null;
    this.visible = false;
    this.busy = false;
    this.error = '';
    this.servers = [];
    this.network.disconnect();
  }
  activate() {
    this.reset();
    if (this.auth.token) this.network.connect();
  }
  get countdown() {
    return false;
  }
  poll() {
    return Promise.resolve();
  }
  show() {
    this.visible = true;
  }
  reconnect() {
    this.network.connect();
  }
}
