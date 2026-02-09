/// <reference types="node" />
import { IncomingMessage, ServerResponse, Server } from 'http';

export interface LinearOptions {
  timeout?: number;
  bodyLimit?: number;
  parseBody?: boolean;
}

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: Record<string, any>;
  params: Record<string, string>;
  body: any;
  responded: boolean;
  error: Error | null;
  status(code: number): this;
  setHeader(name: string, value: string | number): this;
  json(data: any): Promise<void>;
  send(data: any): Promise<void>;
  [key: string]: any; // Allow custom decorators
}

export type Handler = (ctx: Context) => void | Promise<void>;
export type HookHandler = (ctx: Context) => void | Promise<void>;
export type Plugin = (instance: LinearInstance, options: any) => Promise<void>;

export interface LinearInstance {
  server: Server | null;
  config: LinearOptions;
  
  decorate(name: string, value: any): this;
  use(middleware: Handler): this;
  addHook(name: 'onRequest' | 'preValidation' | 'preHandler' | 'onSend' | 'onResponse' | 'onError' | 'onTimeout', fn: HookHandler): this;
  
  register(plugin: Plugin, options?: { prefix?: string }): Promise<this>;
  
  get(path: string, handler: Handler): void;
  get(path: string, schema: any, handler: Handler): void;
  
  post(path: string, handler: Handler): void;
  post(path: string, schema: any, handler: Handler): void;
  
  put(path: string, handler: Handler): void;
  put(path: string, schema: any, handler: Handler): void;
  
  delete(path: string, handler: Handler): void;
  delete(path: string, schema: any, handler: Handler): void;

  patch(path: string, handler: Handler): void;
  patch(path: string, schema: any, handler: Handler): void;

  listen(port: number, cb?: () => void): Server;
}

export declare const fp: (plugin: Plugin) => Plugin;

declare const linear: (options?: LinearOptions) => LinearInstance;
export default linear;