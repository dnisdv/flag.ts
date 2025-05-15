import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    FlagDefinitionError,
    FlagParseError,
    HelpRequestError,
    BooleanValue,
    StringValue,
    NumberValue,
    StringListValue,
    Flag,
    FlagSet,
    type IArgumentProvider,
    type IOutputWriter,
} from './flag';

const mockArgProvider = (args: string[]): IArgumentProvider => ({
    getArguments: () => args,
});

const mockOutputWriter = (): IOutputWriter & { logs: string[]; errors: string[] } => ({
    logs: [],
    errors: [],
    log: function(message: string) { this.logs.push(message); },
    error: function(message: string) { this.errors.push(message); },
});

describe('Flag Core Behavior', () => {
    it('BooleanValue should parse valid and reject invalid strings', () => {
        const bv = new BooleanValue(false);
        bv.set("true"); expect(bv.get()).toBe(true);
        bv.set("0"); expect(bv.get()).toBe(false);
        expect(() => bv.set("maybe")).toThrow(FlagParseError);
    });

    it('StringValue should accept any string', () => {
        const sv = new StringValue("default");
        sv.set("hello world"); expect(sv.get()).toBe("hello world");
    });

    it('NumberValue should parse valid and reject invalid numbers', () => {
        const nv = new NumberValue(0);
        nv.set("123.45"); expect(nv.get()).toBe(123.45);
        expect(() => nv.set("not-a-number")).toThrow(FlagParseError);
    });

    it('StringListValue should append values and reset correctly', () => {
        const slv = new StringListValue(["a"]);
        slv.set("b");
        expect(slv.get()).toEqual(["a", "b"]);
        slv._clearAndReset();
        expect(slv.get()).toEqual(["a"]);
    });
});


describe('FlagSet', () => {
    let flagSet: FlagSet;
    let testWriter: IOutputWriter & { logs: string[]; errors: string[] };

    beforeEach(() => {
        testWriter = mockOutputWriter();
        flagSet = new FlagSet("test-cli", { outputWriter: testWriter });
    });

    describe('Flag Definition', () => {
        it('should allow defining various types of flags', () => {
            const b = flagSet.bool("verbose", { description: "v" });
            const s = flagSet.string("name", { description: "n", defaultValue: "test" });
            expect(b).toBeInstanceOf(Flag);
            expect(s).toBeInstanceOf(Flag);
            expect(s.value).toBe("test");
        });

        it('should throw FlagDefinitionError for conflicting flag names or aliases', () => {
            flagSet.string("name", { description: "d" });
            expect(() => flagSet.bool("name", { description: "d2" })).toThrow(FlagDefinitionError);
            flagSet.bool("b", { alias: "x", description: "d" });
            expect(() => flagSet.string("s", { alias: "x", description: "d2" })).toThrow(FlagDefinitionError);
        });

        it('should throw FlagDefinitionError for invalid alias format', () => {
            expect(() => flagSet.bool("long", { alias: "longalias", description: "d" })).toThrow(FlagDefinitionError);
            expect(() => flagSet.bool("long", { alias: "-", description: "d" })).toThrow(FlagDefinitionError);
        });
    });

    describe('Parsing Arguments', () => {
        let bFlag: Flag<boolean>, sFlag: Flag<string>, nFlag: Flag<number>, lFlag: Flag<string[]>;

        beforeEach(() => {
            bFlag = flagSet.bool("verbose", { alias: "v", description: "Verbose output" });
            sFlag = flagSet.string("config", { alias: "c", description: "Config file", defaultValue: "default.json" });
            nFlag = flagSet.number("port", { alias: "p", description: "Port number" });
            lFlag = flagSet.stringList("include", { alias: "i", description: "Include paths" });
        });

        it('should parse long options and their values', () => {
            flagSet.parse(mockArgProvider(["--verbose", "--config", "prod.json", "--port=8080", "restArg"]).getArguments());
            expect(bFlag.value).toBe(true);
            expect(sFlag.value).toBe("prod.json");
            expect(nFlag.value).toBe(8080);
        });

        it('should parse short options (aliases) and their values', () => {
            flagSet.parse(mockArgProvider(["-v", "-c", "user.json", "-p", "3000"]).getArguments());
            expect(bFlag.value).toBe(true);
            expect(sFlag.value).toBe("user.json");
            expect(nFlag.value).toBe(3000);
        });

        it('should parse short options using full name', () => {
            flagSet.parse(mockArgProvider(["-verbose", "-config", "full.json"]).getArguments());
            expect(bFlag.value).toBe(true);
            expect(sFlag.value).toBe("full.json");
        });


        it('should handle string list flags correctly', () => {
            flagSet.parse(mockArgProvider(["--include", "path/a", "-i", "path/b", "--include=path/c"]).getArguments());
            expect(lFlag.value).toEqual(["path/a", "path/b", "path/c"]);
        });

        it('should handle the -- terminator correctly', () => {
            flagSet.parse(mockArgProvider(["--verbose", "--", "--config", "after.json"]).getArguments());
            expect(bFlag.value).toBe(true);
            expect(sFlag.value).toBe("default.json");
        });

        it('should reset values before a new parse if called multiple times', () => {
            flagSet.parse(mockArgProvider(["--verbose", "--config", "first.json"]).getArguments());
            expect(bFlag.value).toBe(true);
            expect(sFlag.value).toBe("first.json");

            flagSet.parse(mockArgProvider(["--config", "second.json"]).getArguments());
            expect(bFlag.value).toBe(false);
            expect(sFlag.value).toBe("second.json");
        });

        it('should throw HelpRequestError for -h or --help', () => {
            expect(() => flagSet.parse(mockArgProvider(["-h"]).getArguments())).toThrow(HelpRequestError);
            expect(() => flagSet.parse(mockArgProvider(["--help"]).getArguments())).toThrow(HelpRequestError);
        });

        it('should throw FlagParseError for unknown flags', () => {
            expect(() => flagSet.parse(mockArgProvider(["--unknown"]).getArguments())).toThrowError(FlagParseError);
            expect(() => flagSet.parse(mockArgProvider(["-u"]).getArguments())).toThrowError(FlagParseError);
        });

        it('should throw FlagParseError for missing required values', () => {
            expect(() => flagSet.parse(mockArgProvider(["--config"]).getArguments())).toThrowError(FlagParseError);
            expect(() => flagSet.parse(mockArgProvider(["-p", "--verbose"]).getArguments())).toThrowError(FlagParseError);
        });

        it('should throw FlagParseError for invalid value types', () => {
            expect(() => flagSet.parse(mockArgProvider(["--port", "not-a-number"]).getArguments())).toThrowError(FlagParseError);
            expect(() => flagSet.parse(mockArgProvider(["--verbose=maybe"]).getArguments())).toThrowError(FlagParseError);
        });
    });

    describe('Help Generation', () => {
        it('generateHelp() should produce formatted help text', () => {
            flagSet.bool("verbose", { alias: "v", description: "Enable verbose output." });
            flagSet.string("file", { description: "Input file.", defaultValue: "input.txt" });
            flagSet.number("retries", { description: "Number of retries.", defaultValue: 0 });


            const help = flagSet.generateHelp();
            expect(help).toContain("Usage:");
        });

        it('printHelp() should call outputWriter.log with generated help', () => {
            const helpSpy = vi.spyOn(flagSet, 'generateHelp').mockReturnValue("Mocked help text");
            flagSet.printHelp();
            expect(testWriter.logs).toContain("Mocked help text");
            helpSpy.mockRestore();
        });
    });

    describe('State Management', () => {
        it('isParsed should be true after parsing, false after reset', () => {
            expect(flagSet.isParsed).toBe(false);
            flagSet.parse(mockArgProvider([]).getArguments());
            expect(flagSet.isParsed).toBe(true);
            flagSet.reset();
            expect(flagSet.isParsed).toBe(false);
        });
    });
});


