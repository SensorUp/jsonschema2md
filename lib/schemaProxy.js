/*
 * Copyright 2019 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
const ghslugger = require('github-slugger');
const { basename, dirname, resolve } = require('path');
const { formatmeta } = require('./formatInfo');
const symbols = require('./symbols');
const { keyword } = require('./keywords');

const myslug = Symbol('myslug');

function loadExamples(file, num = 1) {
  const examplefile = resolve(dirname(file), basename(file).replace(/\..*$/, `.example.${num}.json`));
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const example = require(examplefile);
    return [example, ...loadExamples(file, num + 1)];
  } catch {
    return [];
  }
}

function trimSlug(slug) {
  const parts = slug.split('-');
  const newparts = parts.map(part => part.substr(0, 3));
  return newparts.join('-');
}

const handler = ({
  root = '', filename = '.', schemas, parent, slugger, sparse = false,
}) => {
  const dense = !sparse;
  const meta = {};

  meta[symbols.parent] = () => parent;
  meta[symbols.pointer] = () => root;
  meta[symbols.filename] = () => filename;
  meta[symbols.id] = (target) => {
    // if the schema has it's own ID, use it
    if (target[keyword`$id`]) {
      return target[keyword`$id`];
    }
    if (parent) {
      // if we can determine the parent ID (by walking up the tree, use it)
      return parent[symbols.id];
    }
    return undefined;
  };
  meta[symbols.titles] = (target) => {
    if (parent) {
      // if we can determine the parent titles
      // then we append our own
      // TODO: inject appropriate title here if it can be determined
      // if (typeof target.title !== 'string') {
      //   target[keyword`title`] = 'dummy'; // eslint-disable-line no-param-reassign
      // }
      return [...parent[symbols.titles], target.title];
    }
    // otherwise, it's just our own
    if (typeof target.title === 'string') {
      return [target[keyword`title`]];
    }
    return [];
  };

  meta[symbols.resolve] = (target, prop, receiver) => (path) => {
    // console.log('trying to resolve', path, 'in', receiver[symbols.filename]);
    if (path === undefined) {
      return receiver;
    }
    const [head, ...tail] = typeof path === 'string' ? path.split('/') : path;
    if ((head === '' || head === undefined) && tail.length === 0) {
      return receiver;
    } else if (head === '' || head === undefined) {
      return receiver[symbols.resolve](tail);
    }
    return receiver[head] ? receiver[head][symbols.resolve](tail) : undefined;
  };

  meta[symbols.slug] = (target, prop, receiver) => {
    if (!receiver[myslug] && !parent && receiver[symbols.filename]) {
      if (dense) {
        // eslint-disable-next-line no-param-reassign
        receiver[myslug] = slugger.slug(trimSlug(basename(receiver[symbols.filename]).replace(/\..*$/, '')));
      } else {
        // eslint-disable-next-line no-param-reassign
        receiver[myslug] = slugger.slug(basename(receiver[symbols.filename]).replace(/\..*$/, ''));
      }
    }
    if (!receiver[myslug]) {
      const parentslug = parent[symbols.slug];
      const { title } = receiver;
      const name = receiver[symbols.pointer].split('/').pop();
      if (typeof title === 'string') {
        if (dense) {
          // eslint-disable-next-line no-param-reassign
          receiver[myslug] = slugger.slug(`${parentslug}-${trimSlug(title || name)}`);
        } else {
          // eslint-disable-next-line no-param-reassign
          receiver[myslug] = slugger.slug(`${parentslug}-${title || name}`);
        }
      } else if (dense) {
        // eslint-disable-next-line no-param-reassign
        receiver[myslug] = slugger.slug(`${parentslug}-${trimSlug(name)}`);
      } else {
        // eslint-disable-next-line no-param-reassign
        receiver[myslug] = slugger.slug(`${parentslug}-${name}`);
      }
    }
    return receiver[myslug];
  };

  meta[symbols.meta] = (target, prop, receiver) => formatmeta(receiver);

  return {
    ownKeys: target => Reflect.ownKeys(target),

    get: (target, prop, receiver) => {
      if (typeof meta[prop] === 'function') {
        return meta[prop](target, prop, receiver);
      }

      const retval = Reflect.get(target, prop, receiver);
      if (retval === undefined && prop === keyword`examples` && !receiver[symbols.parent]) {
        return loadExamples(receiver[symbols.filename], 1);
      }
      if (typeof retval === 'object' && retval !== null) {
        if (retval[keyword`$ref`]) {
          const [uri, pointer] = retval.$ref.split('#');
          // console.log('resolving ref', uri, pointer, 'from', receiver[symbols.filename]);
          const basedoc = uri || receiver[symbols.id];
          if (schemas.known[basedoc]) {
            const referenced = schemas.known[basedoc][symbols.resolve](pointer);
            // inject the referenced schema into the current schema
            Object.assign(retval, referenced);
          } else {
            console.error('cannot resolve', basedoc); // eslint-disable-line no-console
          }
        } else if (retval[symbols.filename]) {
          // console.log('I am in a loop!');
          return retval;
        }

        // fix orphaned structures from if/then conditional schemas (anyOf/oneOf)
        if (retval.if) {
          if (retval.if.properties) {
            // lift if.properties.*.title to retval.title
            const conditionValue = Object.keys(retval.if.properties)[0];
            retval.title = `property ${conditionValue} is ${retval.if.properties[conditionValue].const}`;
            // proxy then.properties in place of retval
            retval.properties = retval.then.properties;
            delete retval.if;
            delete retval.then;
          } else if (retval.if.type) {
            // proxy then.condition in place of retval
            const conditionValue = Object.keys(retval.then)[0];
            if (retval.if.type === 'array') {
              retval.title = `type is ${retval.if.type} of ${conditionValue}`;
              retval.allOf = retval.then[conditionValue].allOf;
            } else if (retval.if.type === 'object') {
              retval.title = `type is ${retval.if.type} of ${conditionValue}`;
              retval[conditionValue].properties = retval.then[conditionValue].properties;
            } else {
              retval.title = `type is ${retval.if.type}`;
              retval[conditionValue] = retval.then[conditionValue];
            }
            delete retval.if;
            delete retval.then;
          }
        }

        // console.log('making new proxy from', target, prop, 'receiver', receiver[symbols.id]);
        const subschema = new Proxy(retval, handler({
          root: `${root}/${prop}`,
          parent: receiver,
          filename,
          schemas,
          slugger,
        }));

        if (subschema[keyword`$id`]) {
          // stow away the schema for lookup
          // eslint-disable-next-line no-param-reassign
          schemas.known[subschema[keyword`$id`]] = subschema;
        }
        return subschema;
      }
      return retval;
    },
  };
};

module.exports = {
  ...symbols,
};

module.exports.loader = ({ sparse = false }) => {
  const schemas = {
    loaded: [],
    known: {},
  };

  const slugger = ghslugger();

  return (schema, filename) => {
    console.log('loading', filename); // eslint-disable-line no-console
    const proxied = new Proxy(schema, handler({
      filename,
      schemas,
      slugger,
      sparse,
    }));
    schemas.loaded.push(proxied);
    if (proxied[keyword`$id`]) {
      // stow away the schema for lookup
      schemas.known[proxied[keyword`$id`]] = proxied;
    }
    return proxied;
  };
};
