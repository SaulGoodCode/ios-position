const fs = require('fs');
const JavaScriptObfuscator = require('javascript-obfuscator');

const source = fs.readFileSync('fake_wloc.js', 'utf-8');

const obfuscated = JavaScriptObfuscator.obfuscate(source, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayCallsTransform: false,
    stringArrayCallsTransformThreshold: 0.5,
    stringArrayEncoding: ['base64'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 1,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 2,
    stringArrayWrappersType: 'variable',
    stringArrayThreshold: 0.75,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
    target: 'node'
}).getObfuscatedCode();

fs.writeFileSync('fake_wloc.obf.js', obfuscated);
console.log('Obfuscated: fake_wloc.js → fake_wloc.obf.js');
console.log(`Original: ${(source.length / 1024).toFixed(1)}KB`);
console.log(`Obfuscated: ${(obfuscated.length / 1024).toFixed(1)}KB`);
