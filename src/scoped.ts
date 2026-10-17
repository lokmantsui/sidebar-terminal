import type * as vscode from 'vscode';
import { Effect } from 'effect';

// A VS Code Disposable that lives as long as the current Scope.
export const disposable = <D extends vscode.Disposable>(acquire: () => D) =>
  Effect.acquireRelease(Effect.sync(acquire), (d) => Effect.sync(() => d.dispose()));

// VS Code APIs return Thenables; failures land in the error channel.
export const thenable = <A>(f: () => Thenable<A>) => Effect.tryPromise(() => Promise.resolve(f()));
