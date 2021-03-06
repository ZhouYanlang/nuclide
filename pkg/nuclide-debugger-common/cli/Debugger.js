/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type {VSAdapterExecutableInfo} from '../lib/types';
import type {Capabilities, LaunchRequestArguments} from 'vscode-debugprotocol';
import type {ConsoleIO} from './ConsoleIO';
import type {DebuggerInterface} from './DebuggerInterface';
import * as DebugProtocol from 'vscode-debugprotocol';

import BackTraceCommand from './BackTraceCommand';
import CommandDispatcher from './CommandDispatcher';
import SourceFileCache from './SourceFileCache';
import idx from 'idx';
import nuclideUri from 'nuclide-commons/nuclideUri';
import StepCommand from './StepCommand';
import NextCommand from './NextCommand';
import ThreadsCommand from './ThreadsCommand';

import invariant from 'assert';
import VsDebugSession from '../lib/VsDebugSession';

export default class Debugger implements DebuggerInterface {
  _capabilities: ?Capabilities;
  _console: ConsoleIO;
  _debugSession: ?VsDebugSession;
  _logger: log4js$Logger;
  _activeThread: ?number;
  _threads: Map<number, string> = new Map();
  _sourceFiles: SourceFileCache;

  constructor(logger: log4js$Logger, con: ConsoleIO) {
    this._logger = logger;
    this._console = con;
    this._sourceFiles = new SourceFileCache(
      this._getSourceByReference.bind(this),
    );
  }

  registerCommands(dispatcher: CommandDispatcher): void {
    dispatcher.registerCommand(new BackTraceCommand(this._console, this));
    dispatcher.registerCommand(new ThreadsCommand(this._console, this));
    dispatcher.registerCommand(new StepCommand(this));
    dispatcher.registerCommand(new NextCommand(this));
  }

  getThreads(): Map<number, string> {
    this._ensureDebugSession();
    return this._threads;
  }

  getActiveThread(): ?number {
    this._ensureDebugSession();
    return this._activeThread;
  }

  async getStackTrace(
    thread: number,
    frameCount: ?number = 0,
  ): Promise<DebugProtocol.StackFrame[]> {
    const {body: {stackFrames}} = await this._ensureDebugSession().stackTrace({
      threadId: thread,
      totalFrames: frameCount,
    });
    return stackFrames;
  }

  async stepIn(): Promise<void> {
    const activeThread = this._activeThread;
    if (activeThread == null) {
      throw new Error('There is no active thread to step into.');
    }

    await this._ensureDebugSession().stepIn({threadId: activeThread});
  }

  async stepOver(): Promise<void> {
    const activeThread = this._activeThread;
    if (activeThread == null) {
      throw new Error('There is no active thread to step through.');
    }

    await this._ensureDebugSession().next({threadId: activeThread});
  }

  async getSourceLines(
    source: DebugProtocol.Source,
    start: number,
    length: number,
  ): Promise<string[]> {
    // If `source' contains a non-zero sourceReference, then the adapter
    // supports returning source data; otherwise, we use the given
    // path as a local file system path.
    //
    let lines: string[] = [];
    const sourceReference = source.sourceReference;

    if (sourceReference != null && sourceReference !== 0) {
      lines = await this._sourceFiles.getFileDataBySourceReference(
        sourceReference,
      );
    } else if (source.path != null) {
      lines = await this._sourceFiles.getFileDataByPath(source.path);
    }

    if (start >= lines.length) {
      return [];
    }

    const end = Math.min(start + length, lines.length);
    return lines.slice(start, end);
  }

  async openSession(
    adapterInfo: VSAdapterExecutableInfo,
    launchArgs: LaunchRequestArguments,
  ): Promise<void> {
    this._debugSession = new VsDebugSession(
      process.pid.toString(),
      this._logger,
      adapterInfo,
    );

    const session = this._debugSession;

    this._capabilities = await session.initialize({
      adapterID: 'fbdb',
      pathFormat: 'path',
      linesStartAt1: false,
    });

    session
      .observeOutputEvents()
      .subscribe(x => this._console.output(x.body.output));

    session.observeContinuedEvents().subscribe(this._onContinued.bind(this));

    session.observeStopEvents().subscribe(this._onStopped.bind(this));

    session
      .observeExitedDebugeeEvents()
      .subscribe(this._onExitedDebugee.bind(this));

    session
      .observeTerminateDebugeeEvents()
      .subscribe(this._onTerminatedDebugee.bind(this));

    await session.launch(launchArgs);
    await this._cacheThreads();
  }

  async closeSession(): Promise<void> {
    if (this._debugSession == null) {
      return;
    }

    await this._debugSession.disconnect();
    this._threads = new Map();
    this._debugSession = null;
    this._activeThread = null;

    // $TODO perf - there may be some value in not immediately flushing
    // and keeping the cache around if we reattach to the same target,
    // using watch to see if the file has changed in the meantime
    this._sourceFiles.flush();
  }

  _onContinued(event: DebugProtocol.ContinuedEvent) {
    // if the thread we're actively debugging starts running,
    // stop interactivity until the target stops again
    if (event.body.threadId === this._activeThread) {
      this._console.stopInput();
    }
  }

  async _onStopped(event: DebugProtocol.StoppedEvent) {
    const stopThread = event.body.threadId;

    if (stopThread != null && stopThread === this._activeThread) {
      const topOfStack = await this._getTopOfStackSourceInfo(stopThread);
      if (topOfStack != null) {
        this._console.outputLine(
          `${topOfStack.name}:${topOfStack.frame.line + 1} ${topOfStack.line}`,
        );
      }

      this._console.startInput();
    }
  }

  _onExitedDebugee(event: DebugProtocol.ExitedEvent) {
    this._console.outputLine(
      `Target exited with status ${event.body.exitCode}`,
    );
    this.closeSession();
  }

  _onTerminatedDebugee(event: DebugProtocol.TerminatedEvent) {
    // Some adapters will send multiple terminated events.
    if (this._debugSession == null) {
      return;
    }
    this._console.outputLine('The target has exited.');
    this.closeSession();
    this._console.startInput();
  }

  async _cacheThreads(): Promise<void> {
    invariant(
      this._debugSession != null,
      '_cacheThreads called without session',
    );

    const {body: {threads}} = await this._debugSession.threads();
    this._threads = new Map(threads.map(thd => [thd.id, thd.name]));

    this._activeThread = null;
    if (threads.length > 0) {
      this._activeThread = threads[0].id;
    }
  }

  async _getTopOfStackSourceInfo(
    threadId: number,
  ): Promise<?{
    line: string,
    name: string,
    frame: DebugProtocol.StackFrame,
  }> {
    // $TODO paths relative to project root?
    const frames = await this.getStackTrace(threadId, 1);
    const source = Debugger._sourceFromTopFrame(frames);
    if (source == null) {
      return null;
    }

    const frame = frames[0];
    const lines = await this.getSourceLines(source, frames[0].line, 1);

    let name: string;

    if (source.path != null) {
      const path = nuclideUri.resolve(source.path);
      name = nuclideUri.split(path).pop();
    } else if (source.name != null) {
      name = source.name;
    } else {
      // the spec guarantees that name is always defined on return, so
      // we should never get here.
      return null;
    }

    return {
      line: lines.length > 0 ? lines[0] : '',
      name,
      frame,
    };
  }

  static _sourceFromTopFrame(
    frames: DebugProtocol.StackFrame[],
  ): ?DebugProtocol.Source {
    return idx(frames, _ => _[0].source) || null;
  }

  async _getSourceByReference(sourceReference: number): Promise<string> {
    const {body: {content}} = await this._ensureDebugSession().source({
      sourceReference,
    });
    return content;
  }

  _ensureDebugSession(): VsDebugSession {
    if (this._debugSession == null) {
      throw new Error('There is no active debugging session.');
    }
    return this._debugSession;
  }
}
