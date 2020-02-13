import { EventEmitter } from "eventemitter3";
import logger from "./logger";
import { Socket } from "./socket";
import { SocketEventType } from "./enums";

const CONNECTION_OPEN_TIMEOUT = 5000;

/**
 * An implementation of chained XHR polling.
 */
class HttpRequestLongPoll {
  index = 1;
  readonly buffer: number[] = [];
  previousRequest: HttpRequestLongPoll;
  private _xmlHttpRequest = new XMLHttpRequest();

  private _onError = sender => { sender; };
  private _onSuccess = sender => { sender; };

  set onError(handler) {
    this._onError = handler;
  }

  set onSuccess(handler) {
    this._onSuccess = handler;
  }

  constructor(readonly streamIndex: number, private readonly _httpUrl: string) {

    this._xmlHttpRequest.onerror = () => {
      this._onError(self);
    };
  
    this._xmlHttpRequest.onerror = () => {
      this._onError(self);
    };

    this._xmlHttpRequest.onreadystatechange = () => {
      if (this.needsClearPreviousRequest()) {
        this.clearPreviousRequest();
      } else if (this.isSuccess()) {
        this._onSuccess(self);
      }
    };
  }

  send(): void {
    this._xmlHttpRequest.open(
      "post",
      this._httpUrl + "/id?i=" + this.streamIndex,
      true
    );
    this._xmlHttpRequest.send(null);

    setTimeout(() => {
      if(this._xmlHttpRequest.readyState < 2) {
        this.abort();
        this._onError(self);
      }
    }, CONNECTION_OPEN_TIMEOUT);
  }

  abort(): void {
    this._xmlHttpRequest.abort();
  }

  isSuccess(): boolean {
    return (
      this._xmlHttpRequest.readyState > 2 &&
      this._xmlHttpRequest.status === 200 &&
      !!this._xmlHttpRequest.responseText
    );
  }

  needsClearPreviousRequest(): boolean {
    return (this._xmlHttpRequest.readyState === 2 && !!this.previousRequest) ||
      (!!this.previousRequest
        && this.previousRequest._xmlHttpRequest.readyState < 2);
  }

  clearPreviousRequest(): void {
    if (!this.previousRequest) return;

    this.previousRequest.abort();
    this.previousRequest = null;
  }

  getMessages(): string[] {
    return this._xmlHttpRequest.responseText.split("\n");
  }

  hasBufferedIndices(): boolean {
    return this.buffer.length > 0;
  }

  popBufferedIndex(): number {
    return this.buffer.shift();
  }

  pushIndexToBuffer(index: number) {
    this.buffer.push(index);
  }
}

/**
 * An abstraction on top of XHR to provide
 * possible connection for peers.
 */
export class HttpRequest extends EventEmitter {
  private readonly HTTP_TIMEOUT = 25000;//ms

  private _disconnected: boolean = true;
  private _id?: string;
  private _httpUrl?: string;
  private _timeout?: any;
  private _messagesQueue: Array<object> = [];
  private _httpRequest?: HttpRequestLongPoll;
  private readonly _baseUrl: string;

  constructor(
    secure: any,
    host: string,
    port: number,
    path: string,
    key: string,
  ) {
    super();

    const httpProtocol = secure ? "https://" : "http://";
    this._baseUrl = httpProtocol + host + ":" + port + path + key;
  }

  start(id: string, token: string): void {

    if (!!this._httpRequest || !this._disconnected) {
      return;
    }

    this._id = id;
    this._httpUrl = `${this._baseUrl}/${this._id}/${token}`;

    this._startXhrStream();
    this._disconnected = false;
  }

  /** Exposed send for DC & Peer. */
  send(data: any): void {
    if (this._disconnected) {
      return;
    }

    // If we didn't get an ID yet, we can't yet send anything so we should queue
    // up these messages.
    if (!this._id) {
      this._messagesQueue.push(data);
      return;
    }

    if (!data.type) {
      this.emit(SocketEventType.Error, "Invalid message");
      return;
    }

    const message = JSON.stringify(data);

    const http = new XMLHttpRequest();
    const url = this._httpUrl + "/" + data.type.toLowerCase();
    http.open("post", url, true);
    http.setRequestHeader("Content-Type", "application/json");
    http.send(message);
  }

  close(): void {
    if (this._disconnected) {
      return;
    }

    this._cleanup();

    this._disconnected = true;
  }

  /** Start XHR streaming. */
  private _startXhrStream(streamIndex: number = 0) {
    const newRequest = new HttpRequestLongPoll(streamIndex, this._httpUrl);
    this._httpRequest = newRequest;

    newRequest.onError = () => {
      // If we get an error, likely something went wrong.
      // Stop streaming.
      clearTimeout(this._timeout);
      this.emit(SocketEventType.Disconnected);
    };

    newRequest.onSuccess = () => {
      this._handleStream(newRequest);
    };

    try {
      newRequest.send();
      this._setHTTPTimeout();
    } catch (e) {
      logger.log("Error while sending through XMLHttpRequest", e.message);
    }
  }

  /** Handles onreadystatechange response as a stream. */
  private _handleStream(httpRequest: HttpRequestLongPoll) {
    // 3 and 4 are loading/done state. All others are not relevant.
    const messages = httpRequest.getMessages();

    // Check to see if anything needs to be processed on buffer.

    while (httpRequest.hasBufferedIndices()) {
      const index = httpRequest.popBufferedIndex();
      let bufferedMessage = messages[index];

      try {
        bufferedMessage = JSON.parse(bufferedMessage);
      } catch (e) {
        //TODO should we need to put it back?
        httpRequest.buffer.unshift(index);
        break;
      }

      this.emit(SocketEventType.Message, bufferedMessage);
    }

    let message = messages[httpRequest.index];

    if (message) {
      httpRequest.index += 1;
      // Buffering--this message is incomplete and we'll get to it next time.
      // This checks if the httpResponse ended in a `\n`, in which case the last
      // element of messages should be the empty string.
      if (httpRequest.index === messages.length) {
        httpRequest.pushIndexToBuffer(httpRequest.index - 1);
      } else {
        try {
          message = JSON.parse(message);
        } catch (e) {
          logger.log("Invalid server message", message);
          return;
        }
        this.emit(SocketEventType.Message, message);
      }
    }
  }

  private _setHTTPTimeout() {
    this._timeout = setTimeout(() => {
      const oldHttp = this._httpRequest;
      this._startXhrStream(oldHttp.streamIndex + 1);
      this._httpRequest.previousRequest = oldHttp;
    }, this.HTTP_TIMEOUT);
  }

  private _cleanup(): void {
    clearTimeout(this._timeout);
     if(this._httpRequest) {
        this._httpRequest.abort();
    }
  }
}

/**
 * A wrapper around Socket, with fallback to XHR long polling
 */
export class ServerConnection extends Socket {

  private _serverId: string;
  private _serverToken: string;

  private _webSocket: Socket;
  private _httpRequest: HttpRequest;
  private _currentConnection: Socket | HttpRequest;

  private _socketOpenTimeout: any;

  constructor(
    secure: any,
    host: string,
    port: number,
    path: string,
    key: string,
    pingInterval?: number,
  ) {
    super(null, null, null, null, null);

    this._webSocket = new Socket(secure, host, port, path, key, pingInterval);
    this._webSocket.emit = this._interceptedSocketEmit.bind(this);

    this._httpRequest = new HttpRequest(secure, host, port, path, key);
    this._httpRequest.emit = this._interceptedHttpRequestEmit.bind(this);
  }

  start(id: string, token: string): void {

    this._serverId = id;
    this._serverToken = token;

    this._startSocket();
  }

  send(data: any): void {
    this._currentConnection && this._currentConnection.send(data);
  }

  close(): void {
    this._stopSocketOpenTimeout();
    this._currentConnection && this._currentConnection.close();
    this._currentConnection = null;
  }

  private _startSocketOpenTimeout() {
    this._stopSocketOpenTimeout();
    this._socketOpenTimeout = setTimeout(() => this._startHttp(),
      CONNECTION_OPEN_TIMEOUT);
  }
  private _stopSocketOpenTimeout() {
    clearTimeout(this._socketOpenTimeout);
    this._socketOpenTimeout = null;
  }

  private _startSocket() {
    this._currentConnection = null;
    this._httpRequest.close();
    this._currentConnection = this._webSocket;

    this._startSocketOpenTimeout();
    this._webSocket.start(this._serverId, this._serverToken);
  }
  private _startHttp() {
    this._currentConnection = null;
    this._webSocket.close();
    this._currentConnection = this._httpRequest;

    this._stopSocketOpenTimeout();
    this._httpRequest.start(this._serverId, this._serverToken);
  }

  private _interceptedSocketEmit(event: string, ...args: Array<any>) {
    if(this._socketOpenTimeout) {
      switch(event) {
        case SocketEventType.Disconnected:
          return this._startHttp();
        case SocketEventType.Message:
          this._stopSocketOpenTimeout();
          break;
      }
    }

    this._currentConnection === this._webSocket && this.emit(event, ...args);
  }
  private _interceptedHttpRequestEmit(event: string, ...args: Array<any>) {
    this._currentConnection === this._httpRequest && this.emit(event, ...args);
  }
}

/** Factory method */
export function createServerConnection(
    secure: any,
    host: string,
    port: number,
    path: string,
    key: string,
    pingInterval?: number,
    useXHRStreamFallback?: boolean
) : Socket {
  return !useXHRStreamFallback
    ? new Socket(secure, host, port, path, key, pingInterval)
    : new ServerConnection(secure, host, port, path, key, pingInterval);
}