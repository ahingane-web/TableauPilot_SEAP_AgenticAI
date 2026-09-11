/**
 * Tableau calculation FUNCTION REFERENCE (embedded knowledge).
 *
 * A compact, comprehensive reference of Tableau calc-language functions, operators, and
 * proven formula patterns, distilled from the official Tableau Help "Functions in Tableau"
 * documentation (https://help.tableau.com/current/pro/desktop/en-us/functions.htm) and its
 * per-category reference topics (Number, String, Date, Type Conversion, Logical, Aggregate,
 * Table Calculation, User) plus Level of Detail expressions.
 *
 * This is injected into the CalculationEngineer (and referenced by the planner) so the agent
 * ALWAYS writes valid Tableau syntax with correct argument order, aggregation rules, NULL
 * handling, and date boundaries — instead of guessing. Keep formulas SIMPLE; reach for LOD /
 * table calcs only when the grain genuinely demands it.
 */
export const TABLEAU_FUNCTIONS_REFERENCE = `# TABLEAU CALCULATION FUNCTION REFERENCE (authoritative — use exactly this syntax)

## Syntax basics
- Field references use square brackets: [Field Name]. String literals use single or double quotes: 'text'. Date literals use #: #2018-09-22# (or #2018-09-22 14:52:00#).
- Operators: + - * / % (modulo), ^ or POWER for exponent, = == != <> > >= < <=, AND OR NOT, IN. Comment with // or /* */.
- A calc is EITHER row-level (operates per record) OR aggregate (returns one value per partition). NEVER mix them in one expression (e.g. IF SUM([Sales]) > [Row Target] is INVALID). Wrap the row-level side in an aggregate, or use an LOD.

## Aggregate functions (return one value per partition; produce AGG(...) pills)
- SUM(expr), AVG(expr), MEDIAN(expr), MIN(expr), MAX(expr) — MIN/MAX also compare two args: MIN(a,b)/MAX(a,b) are ROW-LEVEL.
- COUNT(expr) — count of non-null; COUNTD(expr) — count DISTINCT.
- ATTR(expr) — returns the value if it's unique across the group, else * (great for de-duped labels).
- STDEV(expr), STDEVP(expr), VAR(expr), VARP(expr) — sample/population stdev & variance.
- PERCENTILE(expr, number) — number in 0..1, e.g. PERCENTILE([Sales], 0.9).
- CORR(x, y), COVAR(x, y), COVARP(x, y) — correlation/covariance (table-calc-like, need 2 measures).
- Aggregate a boolean: SUM(INT([Bool])) or COUNTD(IF [cond] THEN [id] END).

## Number functions
- ABS(number); SIGN(number)-> -1/0/1; ROUND(number,[decimals]); CEILING(number); FLOOR(number).
- POWER(number,power) or number^power; SQUARE(number); SQRT(number); EXP(number); LN(number); LOG(number,[base]) (base 10 default); DIV(int1,int2)-> integer part.
- MIN(a,b)/MAX(a,b) row-level compare; PI(); trig: SIN COS TAN COT ASIN ACOS ATAN ATAN2(y,x) (radians); RADIANS(deg); DEGREES(rad); MOD via %.
- ZN(expr) -> returns expr if non-null else 0 (use to make nulls safe in arithmetic).
- HEXBINX(x,y)/HEXBINY(x,y) for hex-bin maps.

## String functions
- LEN(string); LEFT(s,n); RIGHT(s,n); MID(s,start,[length]) (1-indexed); TRIM/LTRIM/RTRIM(s); UPPER/LOWER/PROPER(s).
- CONTAINS(s,sub)-> bool; STARTSWITH(s,sub); ENDSWITH(s,sub); FIND(s,sub,[start])-> index or 0; FINDNTH(s,sub,occurrence).
- REPLACE(s,sub,replacement); SPLIT(s,delimiter,tokenNumber) (negative token = count from right); SPACE(n); CHAR(n); ASCII(s).
- For case-insensitive substring match: CONTAINS(LOWER([Field]),'x'). Regex (some sources): REGEXP_MATCH, REGEXP_EXTRACT, REGEXP_EXTRACT_NTH, REGEXP_REPLACE.

## Date functions
- date_part string values: 'year','quarter','month','dayofyear','day','weekday','week','hour','minute','second', and ISO: 'iso-year','iso-quarter','iso-week','iso-weekday'.
- YEAR(date); QUARTER(date); MONTH(date); WEEK(date); DAY(date) -> integers. ISOYEAR/ISOQUARTER/ISOWEEK/ISOWEEKDAY(date).
- DATEPART(date_part, date, [start_of_week]) -> integer; DATENAME(date_part, date, [start_of_week]) -> string.
- DATETRUNC(date_part, date, [start_of_week]) -> date rounded DOWN to that part (e.g. first day of month). Use for monthly/quarterly trends.
- DATEADD(date_part, interval, date) -> date; DATEDIFF(date_part, date1, date2, [start_of_week]) -> integer (date2 - date1).
- TODAY() -> date; NOW() -> datetime. MAKEDATE(year,month,day); MAKETIME(h,m,s); MAKEDATETIME(date,time).
- DATE(expr)/DATEPARSE(format, string) convert to date; ISDATE(string)-> bool (string input only).
- [start_of_week] e.g. 'monday' overrides the data source default; ISO parts always start Monday.

## Type conversion
- DATE(expr); DATETIME(expr); FLOAT(expr); INT(expr) (truncates toward zero); STR(expr); BOOL(expr).
- MAKEPOINT(lat,long) and MAKELINE(point1,point2) for spatial.

## Logical functions (NULL-aware)
- IF <test> THEN <a> [ELSEIF <test> THEN <b>] [ELSE <c>] END. (ELSE catches false AND null.)
- IIF(test, thenVal, elseVal, [unknownVal]) — inline; optional 4th value only for NULL.
- CASE <expr> WHEN <v1> THEN <r1> WHEN <v2> THEN <r2> [ELSE <default>] END. Also: CASE WHEN <bool> THEN ... (Tableau supports WHEN IN (set/list)). CASE compares a single expression to constants — it cannot test arbitrary boolean conditions (use IF for those).
- AND, OR (short-circuit), NOT. IN: <expr> IN (v1,v2,...) or [Field] IN [Set].
- ISNULL(expr)-> bool; IFNULL(expr, ifNullValue)-> value; ZN(expr)-> expr or 0.

## Level of Detail (LOD) expressions — control the grain independent of the viz
- { FIXED [Dim], ... : <aggregate> } — computes at exactly the listed dims, ignoring viz dims. e.g. { FIXED [Customer ID] : SUM([Sales]) }.
- { INCLUDE [Dim] : <aggregate> } — viz grain PLUS the listed dims (then re-aggregated up).
- { EXCLUDE [Dim] : <aggregate> } — viz grain MINUS the listed dims.
- Body must be an aggregate. Order of Operations: FIXED runs BEFORE dimension filters (add to Context to filter it); INCLUDE/EXCLUDE run after. % of total via LOD: SUM([Sales]) / SUM({ FIXED : SUM([Sales]) }).

## Table calculations (depend on the viz layout / addressing — set Compute Using)
- Running/window: RUNNING_SUM(expr), RUNNING_AVG, RUNNING_MIN, RUNNING_MAX; WINDOW_SUM(expr,[start,end]), WINDOW_AVG, WINDOW_MIN, WINDOW_MAX, WINDOW_MEDIAN, WINDOW_COUNT, WINDOW_STDEV, WINDOW_VAR.
- Positional: INDEX(); SIZE(); FIRST(); LAST(); LOOKUP(expr, [offset]); PREVIOUS_VALUE(expr).
- Ranking: RANK(expr,['asc'|'desc']); RANK_DENSE; RANK_MODIFIED; RANK_UNIQUE; RANK_PERCENTILE(expr). TOTAL(aggregate).
- Period-over-period: (SUM([Sales]) - LOOKUP(SUM([Sales]), -1)) / ABS(LOOKUP(SUM([Sales]), -1)).

## User functions (for row-level security / personalization)
- USERNAME(); FULLNAME(); USERDOMAIN(); ISUSERNAME('name')-> bool; ISMEMBEROF('group')-> bool.

## PROVEN PATTERNS (prefer these; keep them simple)
- Safe ratio / margin (guard divide-by-zero): IF SUM([Sales]) = 0 THEN NULL ELSE SUM([Profit]) / SUM([Sales]) END. (This is an ALREADY-AGGREGATED measure — do not re-aggregate it.)
- Simple total/avg of ONE field: just place the field with SUM/AVG — do NOT make a calc for it.
- Monthly trend axis: DATETRUNC('month', [Order Date]).
- Days to ship: DATEDIFF('day', [Order Date], [Ship Date]).
- Year-over-year %: use LOOKUP as above (a table calc; note Compute Using = the date).
- % of total: SUM([Sales]) / TOTAL(SUM([Sales]))  (table calc)  OR  SUM([Sales]) / SUM({ FIXED : SUM([Sales]) })  (LOD).
- Bucketing: IF [Sales] >= 1000 THEN 'High' ELSEIF [Sales] >= 100 THEN 'Medium' ELSE 'Low' END.
- Null-safe sum in arithmetic: ZN(SUM([Sales])).

## HARD RULES
1. Never mix aggregate and non-aggregate arguments in one expression.
2. Always guard division by zero (IF denom = 0 THEN NULL ELSE num/denom END or use ZN carefully).
3. Every [Field] you reference MUST exist in the datasource (verify with tools); never invent one.
4. Close every IF/CASE with END; every ELSEIF/WHEN needs a THEN.
5. Prefer the SIMPLEST correct expression; only use LOD/table calcs when the grain truly requires it, and state the required Compute Using / Context Filter in configNotes.`;
