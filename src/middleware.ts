import options from 'virtual:bicho/server-options';
import { createMiddleware } from './server.js';

export const onRequest = createMiddleware(options);
