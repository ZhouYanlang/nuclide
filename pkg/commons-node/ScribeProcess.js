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

import os from 'os';
import {spawn} from 'nuclide-commons/process';
import which from 'nuclide-commons/which';
import once from './once';

const DEFAULT_JOIN_TIMEOUT = 5000;
let SCRIBE_CAT_COMMAND = 'scribe_cat';

// On Mac OS, `scribe_cat` isn't quite the same as the server-side one:
// it only dumps its logs on exit. To make sure that logs are delivered
// in a timely manner, we'll periodically force-kill the process.
const DEFAULT_JOIN_INTERVAL = process.platform === 'darwin' ? 60000 : null;

/**
 * A wrapper of `scribe_cat` (https://github.com/facebookarchive/scribe/blob/master/examples/scribe_cat)
 * command. User could call `new ScribeProcess($scribeCategoryName)` to create a process and then
 * call `scribeProcess.write($object)` to save an JSON schemaed Object into scribe category.
 * It will also recover from `scribe_cat` failure automatically.
 */
export default class ScribeProcess {
  _scribeCategory: string;
  _childPromise: ?Promise<child_process$ChildProcess>;
  _subscription: ?rxjs$ISubscription;
  _joinTimer: ?number;
  _joinInterval: ?number;

  constructor(
    scribeCategory: string,
    joinInterval: ?number = DEFAULT_JOIN_INTERVAL,
  ) {
    this._scribeCategory = scribeCategory;
    this._joinInterval = joinInterval;
    this._getChildProcess();
  }

  /**
   * Check if `scribe_cat` exists in PATH.
   */
  static isScribeCatOnPath: () => Promise<boolean> = once(() =>
    which(SCRIBE_CAT_COMMAND).then(cmd => cmd != null),
  );

  /**
   * Write a string to a Scribe category.
   * Ensure newlines are properly escaped.
   */
  async write(message: string): Promise<void> {
    const child = await this._getChildProcess();
    await new Promise(resolve => {
      child.stdin.write(`${message}${os.EOL}`, resolve);
    });
  }

  /**
   * Waits for the remaining messages to be written, then closes the write stream. Resolves once the
   * process has exited. This method is called when the server shuts down in order to guarantee we
   * capture logging during shutdown.
   */
  async join(timeout: number = DEFAULT_JOIN_TIMEOUT): Promise<void> {
    const {_childPromise, _subscription} = this;
    if (_childPromise == null || _subscription == null) {
      return;
    }

    // join() renders the existing process unusable.
    // The next call to write() should create a new process, so clear out the references.
    // Note that we stored them in local variables already above.
    this._clear();

    const child = await _childPromise;
    const {stdin} = child;
    const waitForExit = new Promise(resolve => {
      child.on('exit', () => {
        resolve();
      });
      setTimeout(() => {
        _subscription.unsubscribe();
        resolve();
      }, timeout);
    });
    // Make sure stdin has drained before ending it.
    if (!stdin.write(os.EOL)) {
      stdin.once('drain', () => stdin.end());
    } else {
      stdin.end();
    }
    return waitForExit;
  }

  _getChildProcess(): Promise<child_process$ChildProcess> {
    if (this._childPromise) {
      return this._childPromise;
    }

    // Obtain a promise to get the child process, but don't start it yet.
    // this._subscription will have control over starting / stopping the process.
    const processStream = spawn(SCRIBE_CAT_COMMAND, [this._scribeCategory])
      .do(child => {
        child.stdin.setDefaultEncoding('utf8');
      })
      .finally(() => {
        // We may have already started a new process in the meantime.
        if (this._childPromise === childPromise) {
          this._clear();
        }
      })
      .publish();

    const childPromise = (this._childPromise = processStream
      .first()
      .toPromise());
    this._subscription = processStream.connect();

    if (this._joinInterval != null) {
      this._joinTimer = setTimeout(() => {
        this._joinTimer = null;
        this.join();
      }, this._joinInterval);
    }

    return childPromise;
  }

  _clear() {
    this._childPromise = null;
    this._subscription = null;
    if (this._joinTimer != null) {
      clearTimeout(this._joinTimer);
      this._joinTimer = null;
    }
  }
}

export const __test__ = {
  setScribeCatCommand(newCommand: string): string {
    const originalCommand = SCRIBE_CAT_COMMAND;
    SCRIBE_CAT_COMMAND = newCommand;
    return originalCommand;
  },
};
