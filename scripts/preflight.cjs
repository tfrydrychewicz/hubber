// Runs first in every package script that needs Node 26. Each script calls it itself, because
// npm skips "pre" scripts when ignore-scripts is set. It is CommonJS written in ES5 on purpose:
// this is the one file that has to run on a Node far too old for the rest of the project, and
// such a Node may not understand ES modules or newer syntax at all.
// biome-ignore-all lint/style: old syntax is the point of this file
var fs = require("fs");
var path = require("path");

var REQUIRED_MAJOR = 26;

// An explicit version argument lets the tests exercise the failure without an old Node.
var version = process.argv[2] || process.versions.node;

if (!(parseInt(version.split(".")[0], 10) >= REQUIRED_MAJOR)) {
  console.error("Hubber wymaga Node " + REQUIRED_MAJOR + " lub nowszego (masz " + version + '). Uruchom "nvm use".');
  process.exit(1);
}

// Vite stands for the whole install. Every caller except "diagnose" needs it, and it is a
// devDependency, so this also catches an install that left those out.
if (!fs.existsSync(path.join(__dirname, "..", "node_modules", "vite", "package.json"))) {
  console.error('Brak zainstalowanych zależności. Uruchom "npm install".');
  process.exit(1);
}
