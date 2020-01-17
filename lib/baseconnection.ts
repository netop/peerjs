import { EventEmitter } from "eventemitter3";
import { Peer } from "./peer";
import { ServerMessage } from "./servermessage";
import { ConnectionType } from "./enums";

export abstract class BaseConnection extends EventEmitter {
  protected _open = false;
  protected reconnectTimeoutId = 0;

  readonly metadata: any;
  connectionId: string;
  reconnectable = false;

  peerConnection: RTCPeerConnection;

  abstract get type(): ConnectionType;

  get open() {
    return this._open;
  }

  constructor(
    readonly peer: string,
    public provider: Peer,
    readonly options: any
  ) {
    super();

    this.metadata = options.metadata;
  }

  /** Start a timeout to allow for native reconnection. */
  setCloseTimeout(): boolean {
    if (!this.reconnectable || !this.open) {
      return false;
    }

    this.reconnectTimeoutId || (this.reconnectTimeoutId =
      self.setTimeout(() => this.open && this.close(), 15000));

    return true;
  }

  /** Clear the reconnect timeout. */
  clearCloseTimeout(): void {
    clearTimeout(this.reconnectTimeoutId);
    this.reconnectTimeoutId = 0;
  }

  abstract close(): void;

  abstract handleMessage(message: ServerMessage): void;
}
