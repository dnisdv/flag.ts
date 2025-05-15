import * as flag from './flag'

let n = flag.number("number", { defaultValue: 255, description: "number", alias: "n" })
let b = flag.bool("boolean", { defaultValue: false, description: "boolean", alias: "b" })
let c = flag.bool("boolean2", { defaultValue: false, description: "boolean", alias: "c" })

flag.parse()
console.log(flag.defaultFlagSet.programName)
console.log(b.value)

// flag.printHelp()
//

