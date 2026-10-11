// Runs first in every package script that needs Node 26. Each script calls it itself, because
// npm skips "pre" scripts when ignore-scripts is set. It is CommonJS written in ES5 on purpose:
// this is the one file that has to run on a Node far too old for the rest of the project, and
// such a Node may not understand ES modules or newer syntax at all.
// The two rules that ask for newer syntax are switched off by name, and no others: the rules that
// keep scripts off the network and off the database are of the same group, and hold here too.
// biome-ignore-all lint/style/useNodejsImportProtocol: old syntax is the point of this file
// biome-ignore-all lint/style/useTemplate: old syntax is the point of this file
var fs = require("fs");
var path = require("path");

var REQUIRED_MAJOR = 26;

// An explicit version argument lets the tests exercise the failure without an old Node.
var version = process.argv[2] || process.versions.node;

if (!(parseInt(version.split(".")[0], 10) >= REQUIRED_MAJOR)) {
  console.error("Hubber wymaga Node " + REQUIRED_MAJOR + " lub nowszego (masz " + version + '). Uruchom "nvm use".');
  process.exit(1);
}

// Every package that package.json names has to be in node_modules. A checkout that was updated
// to a version with one more dependency, and not installed again, has all of them but that one,
// and the command would fail in the middle with Node's own "Cannot find package". The
// devDependencies are looked for as well: every caller except "diagnose" and "workspace:create"
// needs them, so this also catches an install that left them out.
var root = path.join(__dirname, "..");
var manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
var names = Object.keys(manifest.dependencies || {}).concat(Object.keys(manifest.devDependencies || {}));
var i;

for (i = 0; i < names.length; i++) {
  if (!fs.existsSync(path.join(root, "node_modules", names[i], "package.json"))) {
    console.error('Brak zainstalowanych zależności. Uruchom "npm install".');
    process.exit(1);
  }
}
