'use strict';
/* @noflow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

/* NON-TRANSPILED FILE */
/* eslint-disable babel/func-params-comma-dangle, prefer-object-spread/prefer-object-spread */

module.exports = function inlineImports(babel) {
  const t = babel.types;

  function requireExpression(moduleID) {
    // require(moduleID);
    return t.callExpression(t.identifier('require'), [t.literal(moduleID)]);
  }

  function memoizeExpression(scope, node, expression) {
    const memoizedID = scope.generateUidIdentifierBasedOnNode(node);
    const memoizedFunction = scope.generateUidIdentifier('load' + memoizedID.name);
    return {
      nodes: [
        // var memoizedID;
        t.variableDeclaration('var', [t.variableDeclarator(memoizedID)]),
        // function memoizedFunction() { return memoizedID = expression; }
        t.functionDeclaration(memoizedFunction, [], t.blockStatement([
          t.returnStatement(t.assignmentExpression('=', memoizedID, expression)),
        ])),
      ],
      memoizedRef:
        // memoizedID || memoizedFunction();
        t.logicalExpression('||', memoizedID, t.callExpression(memoizedFunction, [])),
    };
  }

  function memoizeInteropRequire(scope, node, interop, moduleID) {
    return memoizeExpression(scope, node,
      // $INTEROP(require(moduleID));
      t.callExpression(scope.hub.file.addHelper(interop), [requireExpression(moduleID)])
    );
  }

  return new babel.Transformer('inline-imports', {
    ImportDeclaration(node, parent, scope, state) {
      // flow type
      if (node.importKind === 'type' || node.importKind === 'typeof') {
        return;
      }

      const moduleID = node.source.value;

      // import 'x';
      if (!node.specifiers.length) {
        return requireExpression(moduleID);
      }

      const replacementNodes = [];
      const remaps = state.moduleFormatter.remaps;

      // Default imports come in two flavors. As ImportDefaultSpecifier nodes,
      // or as ImportSpecifier nodes with a "default" imported name:
      //
      //    import Foo from 'x';
      //    import {default as Foo} from '';
      //    import Foo, {default as Foo2, default as Foo3} from '';
      //
      // Both flavors of default imports need an interop. The wildcard interop
      // (used for ImportNamespaceSpecifier) may substitute the default interop.
      // However, the wildcard interop is really expensive, so it's only used
      // when necessary. A default import and an ImportNamespaceSpecifier can
      // only occur when a ImportDefaultSpecifier is followed by a
      // ImportNamespaceSpecifier:
      //
      //    import Foo, * as bar from 'x';
      //
      // ImportNamespaceSpecifier's only appear by themselves or to the "right"
      // of an ImportDefaultSpecifier:
      //
      //    import Foo, * as bar from 'x';
      //    import * as bar from 'x';

      // Find the least expensive interop needed:
      const memoizedInterop =
        node.specifiers.some(specifier => t.isImportNamespaceSpecifier(specifier)) ?
          memoizeInteropRequire(scope, node, 'interop-require-wildcard', moduleID) :
        node.specifiers.some(specifier => t.isSpecifierDefault(specifier)) ?
          memoizeInteropRequire(scope, node, 'interop-require-default', moduleID) :
        null;

      if (memoizedInterop) {
        replacementNodes.push(...memoizedInterop.nodes);
      }

      const memoizedMember =
        node.specifiers.some(specifier =>
          !t.isImportNamespaceSpecifier(specifier) &&
          !t.isSpecifierDefault(specifier))
        ? memoizeExpression(scope, node, requireExpression(moduleID))
        : null;

      if (memoizedMember) {
        replacementNodes.push(...memoizedMember.nodes);
      }

      const inlineImportsData = state.get('inline-imports');

      node.specifiers.forEach(specifier => {
        // import * as bar from 'x';
        if (t.isImportNamespaceSpecifier(specifier)) {
          remaps.add(
            scope,
            specifier.local.name,
            memoizedInterop.memoizedRef
          );

        // import Foo from 'x';
        // import {default as Foo} from 'x';
        } else if (t.isSpecifierDefault(specifier)) {
          remaps.add(
            scope,
            specifier.local.name,
            t.memberExpression(
              memoizedInterop.memoizedRef,
              t.identifier('default')
            )
          );

        // import {baz} from 'x';
        // import {baz as qux} from 'x';
        } else {
          remaps.add(
            scope,
            specifier.local.name,
            t.memberExpression(
              memoizedMember.memoizedRef,
              t.identifier(specifier.imported.name)
            )
          );
        }

        inlineImportsData.imports.push(specifier.local.name);
      });

      return replacementNodes;
    },

    ExportNamedDeclaration(node, parent, scope, state) {
      // flow type
      if (node.kind === 'type') {
        return;
      }
      // export {…}
      if (node.source === null) {
        return;
      }

      const inlineImportsData = state.get('inline-imports');

      node.specifiers.forEach(specifier => {
        inlineImportsData.exports.push(specifier.local.name);
      });
    },

    Program: {
      enter(node, parent, scope, state) {
        state.set('inline-imports', {imports: [], exports: []});
      },
      exit(node, parent, scope, state) {
        const inlineImportsData = state.get('inline-imports');

        for (const name of inlineImportsData.exports) {
          if (inlineImportsData.imports.indexOf(name) !== -1) {
            throw new Error(`importing and exporting "${name}" from the ` +
              'same file is not supported.');
          }
        }

        // Remaps must be run before builtin transforms because short-methods
        // may shadow import names. See "short-method-shadow.test".
        state.moduleFormatter.remaps.run();
      },
    },
  });
};
