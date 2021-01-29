const CompilerSupplier = require("./compilerSupplier");
const Config = require("@truffle/config");
const semver = require("semver");
const Profiler = require("./profiler");
const fse = require("fs-extra");
const { run } = require("./run");
const OS = require("os");
const cloneDeep = require("lodash.clonedeep");

const getSemverExpression = source => {
  return source.match(/pragma solidity(.*);/)[1].trim();
};

const getSemverExpressions = sources => {
  return sources.map(source => getSemverExpression(source));
};

const validateSemverExpressions = semverExpressions => {
  const { validRange } = semver;
  for (const expression of semverExpressions) {
    if (semver.validRange(expression) === null) {
      const message = `Invalid semver expression (${expression}) found in` +
        `one of your contract's imports.`;
      throw new Error(message);
    }
  }
};

// takes an array of versions and an array of semver expressions
// returns a version of the compiler or undefined if none can be found
const findNewestSatisfyingVersion = ({ solcReleases, semverExpressions }) => {
  // releases are ordered from newest to oldest
  return solcReleases.find(version => {
    return semverExpressions.every(expression =>
      semver.satisfies(version, expression)
    );
  });
};

const throwCompilerVersionNotFound = ({ path, semverExpressions }) => {
  const message =
    `Could not find a single version of the Solidity compiler that ` +
    `satisfies the following semver expressions obtained from your source ` +
    `files' pragma statements: ${semverExpressions.join(" - ")}. ` +
    `${OS.EOL}Please check the pragma statements for ${path} and its imports.`;
  throw new Error(message);
};

const compileWithPragmaAnalysis = async ({ paths, options }) => {
  const filteredPaths = paths.filter(
    path => path.endsWith(".sol") || path.endsWith(".json")
  );
  const supplierOptions = {
    events: options.events,
    solcConfig: options.compilers.solc
  };
  const compilerSupplier = new CompilerSupplier(supplierOptions);
  const { releases } = await compilerSupplier.getReleases();

  // collect sources by the version of the Solidity compiler that they require
  const versionsAndSources = {};
  for (const path of paths) {
    const source = (await options.resolver.resolve(path)).body;

    const parserVersion = findNewestSatisfyingVersion({
      solcReleases: releases,
      semverExpressions: [getSemverExpression(source)]
    });
    if (!parserVersion) {
      throwCompilerVersionNotFound({
        path,
        semverExpressions: [getSemverExpression(source)]
      });
    }

    // allSources is of the format { [filename]: string }
    const { allSources } = await Profiler.requiredSourcesForSingleFile(
      options.with({
        path,
        base_path: options.contracts_directory,
        resolver: options.resolver,
        compilers: {
          solc: {
            version: parserVersion
          }
        }
      })
    );

    // get an array of all the semver expressions in the sources
    const semverExpressions = await getSemverExpressions(
      Object.values(allSources)
    );

    // this really just validates the expressions from the contracts' imports
    // as it has already determined the parser version for each contract
    validateSemverExpressions(semverExpressions);

    const newestSatisfyingVersion = findNewestSatisfyingVersion({
      solcReleases: releases,
      semverExpressions
    });
    if (!newestSatisfyingVersion) {
      throwCompilerVersionNotFound({
        path,
        semverExpressions
      });
    }

    if (versionsAndSources[newestSatisfyingVersion]) {
      versionsAndSources[newestSatisfyingVersion] = {
        ...versionsAndSources[newestSatisfyingVersion],
        ...allSources
      };
    } else {
      versionsAndSources[newestSatisfyingVersion] = allSources;
    }
  }

  const compilations = [];
  for (const compilerVersion of Object.keys(versionsAndSources)) {
    const compilationOptions = Object.assign(
      {},
      { compilers: cloneDeep(options.compilers) }
    );
    compilationOptions.compilers.solc.version = compilerVersion;

    const config = Config.default().with(compilationOptions);
    const compilation = await run(
      versionsAndSources[compilerVersion],
      config
    );
    if (compilation.contracts.length > 0) {
      compilations.push(compilation);
    }
  }
  return { compilations };
};

module.exports = {
  compileWithPragmaAnalysis
};
