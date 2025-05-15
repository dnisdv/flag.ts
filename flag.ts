
import * as process from 'node:process';
import * as path from 'node:path';

export class FlagError extends Error {
    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
    }
}
export class FlagDefinitionError extends FlagError { }
export class FlagParseError extends FlagError {
    constructor(
        message: string,
        public readonly flagName?: string,
        public readonly offendingValue?: string | undefined
    ) {
        const baseMessage = flagName ? `Flag '${flagName}': ${message}` : message;
        const fullMessage = offendingValue !== undefined ? `${baseMessage} (value: "${offendingValue}")` : baseMessage;
        super(fullMessage);
    }
}

export class HelpRequestError extends FlagError {
    constructor() {
        super("Help requested by user");
        this.name = "HelpRequestError";
    }
}

export interface IFlag<T> {
    set(stringValue: string): void;
    get(): T;
    asString(): string;
    typeName(): string;
    expectsExplicitValue(): boolean;
    _clearAndReset(stringValue?: string): void;
}

export class BooleanValue implements IFlag<boolean> {
    private currentValue: boolean;
    constructor(defaultValue: boolean) {
        this.currentValue = defaultValue;
    }
    set(stringValue: string): void {
        const lower = stringValue.toLowerCase();
        if (lower === 'true' || lower === '1') this.currentValue = true;
        else if (lower === 'false' || lower === '0') this.currentValue = false;
        else throw new FlagParseError(`invalid boolean value`, undefined, stringValue);
    }
    get(): boolean { return this.currentValue; }
    asString(): string { return String(this.currentValue); }
    typeName(): string { return 'boolean'; }
    expectsExplicitValue(): boolean { return false; }

    _clearAndReset(value: string): void { (value && this.set(value)); }
}

export class StringValue implements IFlag<string> {
    private currentValue: string;
    constructor(defaultValue: string) {
        this.currentValue = defaultValue;
    }
    set(stringValue: string): void { this.currentValue = stringValue; }
    get(): string { return this.currentValue; }
    asString(): string { return this.currentValue; }
    typeName(): string { return 'string'; }
    expectsExplicitValue(): boolean { return true; }
    _clearAndReset(value: string): void { (value && this.set(value)); }
}

export class NumberValue implements IFlag<number> {
    private currentValue: number;
    constructor(defaultValue: number) {
        this.currentValue = defaultValue;
    }
    set(stringValue: string): void {
        const num = parseFloat(stringValue);
        if (isNaN(num)) {
            throw new FlagParseError(`invalid number`, undefined, stringValue);
        }
        this.currentValue = num;
    }
    get(): number { return this.currentValue; }
    asString(): string { return String(this.currentValue); }
    typeName(): string { return 'number'; }
    expectsExplicitValue(): boolean { return true; }
    _clearAndReset(value: string): void { (value && this.set(value)); }
}

export class StringListValue implements IFlag<string[]> {
    private currentValue: string[];
    private readonly initialDefault: readonly string[];

    constructor(defaultValue: string[] = []) {
        this.initialDefault = Object.freeze([...defaultValue]);
        this.currentValue = [...this.initialDefault];
    }
    set(stringValue: string): void {
        this.currentValue.push(stringValue);
    }

    get(): string[] {
        return [...this.currentValue];
    }
    asString(): string {
        if (this.currentValue.length === 0 && this.initialDefault.length === 0) return "";
        return this.currentValue.join(', ');
    }
    typeName(): string { return 'string[]'; }
    expectsExplicitValue(): boolean { return true; }

    _clearAndReset(_: string): void {
        this.currentValue = [...this.initialDefault];
    }
}

interface FlagConstructorOptions<T> {
    name: string;
    description: string;
    alias?: string;
    valueHolder: IFlag<T>;
}

export class Flag<T> {
    public readonly name: string;
    public readonly description: string;
    public readonly alias?: string;
    private readonly valueHolder: IFlag<T>;
    private readonly initialDefaultValueString: string;
    private _isSet: boolean = false;

    constructor(options: FlagConstructorOptions<T>) {
        this.name = options.name;
        this.description = options.description;

        if (options.alias) {
            if (options.alias.length !== 1 || options.alias === "-" || options.alias === "=") {
                throw new FlagDefinitionError(`Alias for flag "${options.name}" must be a single character and not '-' or '=', got "${options.alias}".`);
            }
            this.alias = options.alias;
        }
        this.valueHolder = options.valueHolder;
        this.initialDefaultValueString = options.valueHolder.asString();
    }

    _setValueFromString(stringValue: string): void {
        this.valueHolder.set(stringValue);
        this._isSet = true;
    }

    _setImplicitly(): void {
        // TODO: propogate responsability to the valueHolder
        if (this.valueHolder.typeName() === 'boolean') {
            this.valueHolder.set("true");
            this._isSet = true;
        } else {
            throw new FlagParseError(`cannot be set implicitly without a value`, this.name);
        }
    }

    _resetToDefault(): void {
        this.valueHolder._clearAndReset(this.initialDefaultValueString);
        this._isSet = false;
    }

    public get value(): T { return this.valueHolder.get(); }
    public get isSet(): boolean { return this._isSet; }
    public get defaultValueAsString(): string { return this.initialDefaultValueString; }
    public typeName(): string { return this.valueHolder.typeName(); }
    public expectsExplicitValue(): boolean { return this.valueHolder.expectsExplicitValue(); }
}

export interface IArgumentProvider {
    getArguments(): readonly string[];
}
export class ProcessArgumentProvider implements IArgumentProvider {
    getArguments(): readonly string[] {
        return process.argv.slice(2);
    }
}

export interface IOutputWriter {
    log(message: string): void;
    error(message: string): void;
}
export class ConsoleOutputWriter implements IOutputWriter {
    log(message: string): void { console.log(message); }
    error(message: string): void { console.error(message); }
}

interface FlagOptionsBase {
    description: string;
    alias?: string;
}
export interface BoolFlagOptions extends FlagOptionsBase { defaultValue?: boolean; }
export interface StringFlagOptions extends FlagOptionsBase { defaultValue?: string; }
export interface NumberFlagOptions extends FlagOptionsBase { defaultValue?: number; }
export interface StringListFlagOptions extends FlagOptionsBase { defaultValue?: string[]; }


enum _ParseOneOutcome {
    FLAG_CONSUMED_AND_PROCESSED,
    TERMINATOR_CONSUMED,
    NOT_A_FLAG_ENCOUNTERED,
}

export class FlagSet {
    private readonly flags = new Map<string, Flag<any>>();
    private readonly aliases = new Map<string, string>();

    private readonly argProvider: IArgumentProvider;
    private readonly outputWriter: IOutputWriter;

    private _programName: string;
    private _isParsed: boolean = false;
    private _processingArgs: string[] = [];

    constructor(
        programName?: string,
        dependencies?: {
            argProvider?: IArgumentProvider;
            outputWriter?: IOutputWriter;
        }
    ) {
        this._programName = programName || (process.argv[1] ? path.basename(process.argv[1]) : "default_name");
        this.argProvider = dependencies?.argProvider || new ProcessArgumentProvider();
        this.outputWriter = dependencies?.outputWriter || new ConsoleOutputWriter();
    }

    private _registerFlag<T>(flag: Flag<T>): void {
        if (this.flags.has(flag.name) || this.aliases.has(flag.name)) {
            throw new FlagDefinitionError(`Flag name or alias "${flag.name}" is already registered.`);
        }
        if (flag.alias) {
            if (this.flags.has(flag.alias) || this.aliases.has(flag.alias) || Array.from(this.aliases.values()).includes(flag.alias)) {
                throw new FlagDefinitionError(`Alias "${flag.alias}" (for flag "${flag.name}") is already registered as a name or alias.`);
            }
            this.aliases.set(flag.alias, flag.name);
        }
        this.flags.set(flag.name, flag);
    }

    public bool(name: string, options: BoolFlagOptions): Flag<boolean> {
        const defaultValue = options.defaultValue ?? false;
        const valueHolder = new BooleanValue(defaultValue);
        const flag = new Flag<boolean>({
            name,
            description: options.description,
            alias: options.alias,
            valueHolder
        });
        this._registerFlag(flag);
        return flag;
    }

    public string(name: string, options: StringFlagOptions): Flag<string> {
        const defaultValue = options.defaultValue ?? "";
        const valueHolder = new StringValue(defaultValue);
        const flag = new Flag<string>({
            name,
            description: options.description,
            alias: options.alias,
            valueHolder
        });
        this._registerFlag(flag);
        return flag;
    }

    public number(name: string, options: NumberFlagOptions): Flag<number> {
        const defaultValue = options.defaultValue ?? 0;
        const valueHolder = new NumberValue(defaultValue);
        const flag = new Flag<number>({
            name,
            description: options.description,
            alias: options.alias,
            valueHolder
        });
        this._registerFlag(flag);
        return flag;
    }

    public stringList(name: string, options: StringListFlagOptions): Flag<string[]> {
        const defaultValue = options.defaultValue ?? [];
        const valueHolder = new StringListValue(defaultValue);
        const flag = new Flag<string[]>({
            name,
            description: options.description,
            alias: options.alias,
            valueHolder
        });
        this._registerFlag(flag);
        return flag;
    }

    public reset(): void {
        this.flags.forEach(flag => flag._resetToDefault());
        this._isParsed = false;
        this._processingArgs = [];
    }

    private _parseOne(): _ParseOneOutcome {
        const arg = this._processingArgs[0];

        if (arg === "--") {
            this._processingArgs.shift();
            return _ParseOneOutcome.TERMINATOR_CONSUMED;
        }

        if (!arg.startsWith("-") || arg === "-") {
            return _ParseOneOutcome.NOT_A_FLAG_ENCOUNTERED;
        }

        this._processingArgs.shift();

        let valueFromEqualsSyntax: string | undefined = undefined;

        const isFullOption = arg.startsWith("--");
        let flagIdentifier = isFullOption ? arg.substring(2) : arg.substring(1);

        const equalsIndex = flagIdentifier.indexOf("=");
        if (equalsIndex !== -1) {
            valueFromEqualsSyntax = flagIdentifier.substring(equalsIndex + 1);
            flagIdentifier = flagIdentifier.substring(0, equalsIndex);
        }

        if (flagIdentifier.length === 0 || flagIdentifier.startsWith("-")) {
            throw new FlagParseError("Invalid flag identifier syntax", arg);
        }

        if (flagIdentifier === "h" || flagIdentifier === "help") {
            throw new HelpRequestError();
        }

        const resolvedFlagName = this.aliases.get(flagIdentifier) || flagIdentifier;
        const flag = this.flags.get(resolvedFlagName);

        if (!flag) {
            throw new FlagParseError(`Unknown flag`, flagIdentifier);
        }

        try {
            if (flag.expectsExplicitValue()) {
                let valueToSet: string;

                if (valueFromEqualsSyntax !== undefined) {
                    valueToSet = valueFromEqualsSyntax;
                } else {
                    if (this._processingArgs.length === 0 || this._processingArgs[0].startsWith("-")) {
                        throw new FlagParseError(`requires a value`, flag.name);
                    }
                    valueToSet = this._processingArgs.shift()!;
                }
                flag._setValueFromString(valueToSet);
            } else {
                if (valueFromEqualsSyntax !== undefined) {
                    flag._setValueFromString(valueFromEqualsSyntax);
                } else {
                    flag._setImplicitly();
                }
            }
        } catch (e: any) {
            if (e instanceof FlagParseError) {
                throw new FlagParseError(e.message, flag.name, e.offendingValue ?? valueFromEqualsSyntax);
            }
            throw new FlagParseError(e.message, flag.name, valueFromEqualsSyntax);
        }

        return _ParseOneOutcome.FLAG_CONSUMED_AND_PROCESSED;
    }

    public parse(argv?: readonly string[]): void {
        if (this._isParsed) {
            this.reset();
        }
        this._processingArgs = [...(argv === undefined ? this.argProvider.getArguments() : argv)];

        try {
            while (this._processingArgs.length > 0) {
                const outcome = this._parseOne();

                switch (outcome) {
                    case _ParseOneOutcome.FLAG_CONSUMED_AND_PROCESSED: continue;
                    case _ParseOneOutcome.TERMINATOR_CONSUMED:
                    case _ParseOneOutcome.NOT_A_FLAG_ENCOUNTERED:
                        this._processingArgs = [];
                        break;
                }
                if (this._processingArgs.length === 0) break;
            }

        } catch (e) {
            this._isParsed = true;
            this._processingArgs = [];
            throw e;
        }

        this._isParsed = true;
        this._processingArgs = [];
    }

    public get isParsed(): boolean { return this._isParsed; }
    public get programName(): string { return this._programName; }

    private _formatFlagSyntaxForHelp(flag: Flag<any>): string {
        const aliasStr = flag.alias ? `-${flag.alias}, ` : "";
        let syntax = `  ${aliasStr}--${flag.name}`;
        const typeName = flag.typeName();

        if (flag.expectsExplicitValue() || typeName === 'boolean') {
            const displayType = typeName === 'string[]' ? 'string' : typeName;
            syntax += typeName === 'boolean' ? ` [=${displayType}]` : ` <${displayType}>`;
        }
        return syntax;
    }


    private _formatDefaultValueForHelp(flag: Flag<any>): string | null {
        const defaultString = flag.defaultValueAsString;
        const typeName = flag.typeName();

        if (defaultString === undefined || defaultString === null) return null;
        if (typeName === 'boolean' && defaultString === 'false') return null;
        if (typeName === 'string' && defaultString === '') return null;
        if (typeName === 'string[]' && defaultString === '') return null;

        if (typeName === 'string') {
            return (defaultString.includes(' ') || defaultString === '')
                ? JSON.stringify(defaultString)
                : defaultString;
        }
        return defaultString;
    }

    public generateHelp(): string {
        const usageLine = `Usage: ${this._programName} [options] ...`;
        const helpParts: string[] = [usageLine, "\nOptions:"];

        const sortedFlags = Array.from(this.flags.values()).sort((a, b) => a.name.localeCompare(b.name));

        if (sortedFlags.length === 0) {
            helpParts.push("  (No options defined)");
            return helpParts.join("\n") + "\n";
        }

        const flagSyntaxStrings = sortedFlags.map(flag => this._formatFlagSyntaxForHelp(flag));
        const maxSyntaxWidth = flagSyntaxStrings.reduce((max, syntax) => Math.max(max, syntax.length), 0);

        const nameColumnWidth = Math.min(maxSyntaxWidth + 4, 45);

        const optionDetailLines = sortedFlags.map((flag, index) => {
            const syntaxPart = flagSyntaxStrings[index].padEnd(nameColumnWidth);
            const descriptionPart = flag.description;
            const defaultDisplayString = this._formatDefaultValueForHelp(flag);

            let line = `${syntaxPart}${descriptionPart}`;
            if (defaultDisplayString !== null) {
                line += ` (default: ${defaultDisplayString})`;
            }
            return line;
        });

        helpParts.push(...optionDetailLines);
        return helpParts.join("\n") + "\n";
    }

    public printHelp(): void {
        this.outputWriter.log(this.generateHelp());
    }
}

export const defaultFlagSet = new FlagSet();
export function bool(name: string, options: BoolFlagOptions): Flag<boolean> { return defaultFlagSet.bool(name, options); }
export function string(name: string, options: StringFlagOptions): Flag<string> { return defaultFlagSet.string(name, options); }
export function number(name: string, options: NumberFlagOptions): Flag<number> { return defaultFlagSet.number(name, options); }
export function stringList(name: string, options: StringListFlagOptions): Flag<string[]> { return defaultFlagSet.stringList(name, options); }

export function parse(argv?: readonly string[]): void {
    try {
        defaultFlagSet.parse(argv);
    } catch (e: any) {
        const writer = (defaultFlagSet as any).outputWriter as IOutputWriter || new ConsoleOutputWriter();

        if (e instanceof HelpRequestError) {
            defaultFlagSet.printHelp();
            if (typeof process !== 'undefined' && process.exit) {
                process.exit(0);
            }
            return;
        }

        writer.error(e.message);
        defaultFlagSet.printHelp();

        if (typeof process !== 'undefined' && process.exit) {
            process.exit(1);
        } else {
            throw e;
        }
    }
}
export function printHelp(): void { defaultFlagSet.printHelp(); }
export function isParsed(): boolean { return defaultFlagSet.isParsed; }

