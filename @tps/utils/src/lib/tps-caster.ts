/**
 * system to cast types with some additional features,
 * schema validation, etc.
 * used in @tps/db after a loading object from DB
 *
 * !!fut: move to @tps/utils module npm package
 *
 * @author Kyrylo Kuzmytskyy <slykirill@gmail.com>
 *
 * @example
 * //we have object from DB:
 * const obj = {
 *  id: '123',
 *  price: '123.45',
 *  date: '2021-01-01',
 *  is_active: 'true',
 *  data: '{"key": "value"}'
 * };
 * //with all caster options turned on wi will have:
 * const ent = TpsCaster.cast(obj, {enableAll: true});
 * //ent will be:
 * const ent = {
 *  id: 123,
 *  price: 123.45,
 *  date: new Date('2021-01-01'),
 *  is_active: true,
 *  data: {key: 'value'}
 * };
 *
 * //usage in post load modifier of the entity:
 * override postLoadModifier = (entity: IProduct): IProduct => {
 *     //cast string numbers to numbers
 *     //(in directus 2024 v11 decimal fields sent as string, we use them for prices)
 *     TpsCaster.cast<IProduct>(entity, {
 *       rewriteFields:true,
 *       stringsToNumbers:true,
 *       stringsToBooleans:false,
 *       deepCasters: {
 *         prices: {
 *           rewriteFields:true,
 *           stringsToNumbers:true
 *         }
 *       }
 *     });
 *     return entity;
 * }
 */
export class TpsCaster {

  static cast<T extends {[key:string]:any}>(obj:T, options?:Partial<TpsCasterOptions>):T {
    if(typeof obj !== 'object') return obj; //if we got, for example, string id instead of object - exit
    const casted = {} as Partial<T>;
    const opts:TpsCasterOptions<T> = options instanceof TpsCasterOptions ? options : new TpsCasterOptions<T>(options);
    opts.enableAllApply();

    //process fields:
    for(const key in obj) {
      // prepare val
      const val = obj[key] as any; if(!val) continue;

      //check if the curr field is forced to skip or only schema fields are allowed
      if(opts.schema && (
        (opts.schema as Record<string, boolean|TpsCasterSchemaTypes>)[key] === false ||
        (opts.onlySchema && !(key in opts.schema))
      )) continue;

      // cast from string data (using flags)
      if(typeof val === 'string' && val.length>0) {
        const castedVal = TpsCaster._castFromString(val, opts);
        if(castedVal !== undefined) { casted[key] = castedVal; continue; }
      }

      //deep casters
      //for objects we can have deep casters
      if(opts.deepCasters && key in opts.deepCasters && typeof val === 'object') {
        const deepOpts = opts.deepCasters[key];
        if(Array.isArray(val))
          casted[key] = val.map((v:any) => TpsCaster.cast(v, deepOpts)) as never;
        else
          casted[key] = TpsCaster.cast(val, deepOpts) as never;
        continue;
      }

      //After standard casts, we can force schema validation
      //for the items that still not in the cast object
      if(opts.schema && (key in opts.schema) && !(key in casted) ) {
        const toType = (opts.schema as Record<string,boolean|TpsCasterSchemaTypes>)[key];
        if(typeof toType === 'boolean') continue;//skip 'true' in schema
        const castedVal = TpsCaster._castSchemaField(val, toType, opts);
        if(castedVal !== undefined) { casted[key] = castedVal; continue; }
      }

    }//cycle fields end

    //check do we need to rewrite or return a new object with cast fields
    if(opts.rewriteFields) return Object.assign<T,Partial<T>>(obj, casted);
    else return Object.assign({}, obj, casted) as T;
  }

  /**
   * for field values that we are forced to cast not by options
   * but by types given in schema.
   *
   * For example, for some fields we could want 0-1 to be boolean,
   * or objects converted to strings, etc.
   *
   * @param val
   * @param toType
   * @param opts used to send to the _castFromString() method
   * @return casted value or undefined if we can't cast it
   * @private
   */
  private static _castSchemaField(val:any, toType:TpsCasterSchemaTypes, opts:TpsCasterOptions):any {
    //for string values that are still not cast, but we forced to cast:
    if(typeof val === 'string' && toType != 'string') {
      const castedVal = TpsCaster._castFromString(val, opts, toType);
      if(castedVal !== undefined) return castedVal;
    }
    //for number values that are still not cast, but we forced to cast:
    if(typeof val === 'number' && toType != 'number') switch (toType) {
      //say received from server 0 and 1 but a client needs boolean
      case 'boolean': return !!val;
      //when we work with strings even if the server converts any numeric string to numbers
      case 'string':  return val.toString();
      //when a timestamp is received from a server
      case 'date': return new Date(val);
    }
    //if we have an object, and we need to cast it to string
    if(typeof val === 'object' && toType == 'string') return JSON.stringify(val);
  }

  /**
   * cast string value to: number, date, boolean, object
   * according to the options given or the type we need to cast to
   * @param val string value from entity field
   * @param opts used to determine how to cast the string by default (could be empty toType given)
   * @param toType if we need to cast to specific type (if we have schema, forced cast even if opts are different)
   * @private
   */
  private static _castFromString(val:string, opts:TpsCasterOptions|undefined, toType?:TpsCasterSchemaTypes|boolean):any {
    // NUMBER:
    // first try to number because it's fastest
    if(toType=='number' || (opts && opts.stringsToNumbers && val.length <= opts.numberMaxChars)) {
      const num = Number(val);
      if (!isNaN(num)) return num;
    }

    // DATE:
    // The maximum length for a datetime string with a time zone in the format yyyy-mm-ddTHH:MM:SSZ is 20 characters
    if(toType=='date' || (opts && opts.stringsToDates && val.length <= 20)) {
      const matches = (opts?.datesMatchRegex || TpsCasterOptions.datesMatchRegexDefault);
      if(matches) for (const regex of matches) if (regex.test(val)) {
        const date = new Date(val);
        if (!isNaN(date.getTime())) return date;
      }
    }

    // BOOLEAN:
    if(toType=='boolean' || (opts && opts.stringsToBooleans && val.length <= 5)) {
      const bool = val.toLowerCase() === 'true';
      if (bool || val.toLowerCase() === 'false') return bool;
    }

    // STRING TO OBJECT (long string could be too):
    if(toType=='object' || (opts && opts.stringsToObjects)) try {
      const obj = JSON.parse(val);
      if (obj && typeof obj === 'object') return obj;
    } catch (e) { /* skp it */ }

  }//_castFromString

}

/**
 * default caster options (all turned off)
 */
export class TpsCasterOptions<T extends object = object> {

  constructor(options?:Partial<TpsCasterOptions>) {
    if(options) Object.assign(this, options);
    if(options?.enableAll) this.enableAllApply();
  }

  /**
   * shortcut to just enable all the options caster has
   * @default false
   * */
  enableAll = false;


  /**
   * do we need to process all fields,
   * or only those that are in the schema given?
   * @default false
   * */
  onlySchema = false;

  /**
   * do we need to update existing object fields
   * or create a copy with cast values?
   * @default false
   */
  rewriteFields = false;

  //---------------------------------

  /**
   * do we need to try converting all strings to numbers? (using Number(val))
   * @see numberMaxChars
   * */
  stringsToNumbers = false;
  /**
   * max number of chars in string to try converting it to number,
   * used to prevent converting long strings to numbers
   * @default 8
   * */
  numberMaxChars = 8;

  /**
   * do we need to try converting all strings to dates?
   * (using new Date(val))
   * @default false
   * */
  stringsToDates = false;

  /**
   * match this before trying to convert string to date
   * (\d{4}-\d{2}-\d{2}): Matches the MySQL date format yyyy-mm-dd.
   * (?:T\d{2}:\d{2}:\d{2}Z)?: Optionally matches the MySQL datetime format yyyy-mm-ddTHH:MM:SSZ.
   * (?:\d{2}-\d{2}-(?:\d{2}|\d{4})): Matches dd-mm-yy or dd-mm-yyyy formats.
   */
  static datesMatchRegexDefault = [/^(?:(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}Z)?)|(?:\d{2}-\d{2}-(?:\d{2}|\d{4}))$/] as const;
  datesMatchRegex = TpsCasterOptions.datesMatchRegexDefault;
  /**
   * do we need to try converting all strings to booleans?
   * only 'true' and 'false' are casted
   * (using val.toLowerCase() === 'true')
   * @default true
   * */
  stringsToBooleans = false;

  /**
   * do we need to try converting all strings to objects?
   * careful, also cast numbers, dates, booleans, etc.
   * (using JSON.parse(val))
   * @default false
   * */
  stringsToObjects = false;

  //---------------------------------

  /**
   * force schema validation for this field only to the given types
   */
  schema?:TpsCasterSchema<T>;

  /**
   * set if you need to cast nested objects,
   * indexed by the field name of the entity.
   * the field could be a nested object or array of objects
   * @example
   * const obj = {
   *   id: '123',
   *   prices: [
   *     {price:'123.45', currency:'usd'},
   *     {price:'234.56', currency:'eur'}
   *   ]
   * }
   * const ent = TpsCaster.cast(obj, {deepCasters: {prices: {price: 'number'}}});
   */
  deepCasters?:Record<string,Partial<TpsCasterOptions>>;

  //---------------------------------

  /**
   * call before processing, to apply data to values
   *
   * we need this so user could create `opts` using:
   * `new TpsCasterOptions({enableAll: true})`
   * it's just a variable, not a method, so we can use it in Object.assign()
   * and then really set the necessary flags
   * */
  enableAllApply(val?:boolean) {
    if(val === undefined) return;
    this.stringsToNumbers = val;
    this.stringsToDates   = val;
    this.stringsToBooleans= val;
    this.stringsToObjects = val;
  }
}

/**
 * field names with the types that are allowed for them,
 * the types just the __string constants__ that are used in the caster
 *
 * if __boolean__ set to:
 *  - `true` validate the field using basic rules (when onlySchema is true)
 *  - `false` skip this field (when onlySchema is false, and we need to process all fields)
 */

export type TpsCasterSchema<T extends object = object, T_ALLOWED = TpsCasterSchemaTypes | boolean> = {
    [key in(T extends object? Extract<keyof T, string> : string)]?: T_ALLOWED;
};


/** default type the caster can work with, and that could be used in schema */
export type TpsCasterSchemaTypes = 'string'|'number'|'date'|'boolean'|'object';

