# Account and desk payoff scenarios

The Overview and Positions views show desk curves across all accounts the current
user can access. An individual account page shows its own curves. The panel uses
the existing authorized positions queries and receives the same live updates as
the leg table. Calculations run in the browser; no new backend endpoint or
market-data subscription is required.

Select a position currency, enter each underlying's reference price, and adjust
the shock range, days forward, annual interest rate, volatility and dividend
yield. A held stock's broker mark supplies its initial reference price; an option
mark is never used as an underlying price. Defaults are explicitly hypothetical:
30% volatility, 0% interest, 0% dividend yield and zero days forward. Inputs are
local to the panel and reset when it is unmounted. Currencies are never added or
converted. The desk is limited to accounts accessible in the active tenant.

## Calculations

* **Terminal payoff:** stock value or option intrinsic value less average cost,
  multiplied by signed quantity. For derivatives, the broker average cost
  already includes the contract multiplier, so the multiplier applies only to
  the scenario option price. For example, a long call with strike 100, multiplier
  100 and average cost 500 has P&L 1,500 at an underlying price of 120.
* **Pre-expiry estimate:** European Black–Scholes value with continuous dividend
  yield at the chosen horizon, less average cost. The horizon cannot pass the
  earliest included expiry. Time is measured in calendar days from the displayed
  UTC date, using a 365-day year. Expiry-day contracts use intrinsic value; this
  is a date-based model and does not model exchange-specific expiry times.
* **Desk aggregation:** every underlying receives the same percentage shock to
  its reference price. Terminal account lines sum to the desk terminal line.
  The dashed line shows aggregate pre-expiry estimated P&L. Individual account
  pages show both curves for that account.
* **Tail visibility:** selectable shocks extend from a total underlying loss
  (−100%) to +200%. Strike breakpoints are included in the terminal curve.
  Reported worst P&L is limited to the plotted range; the pre-expiry minimum is
  sampled. Uncapped upside flags identify short shares or net short calls that
  held shares do not cover. At a single call expiry, long calls can also cap
  short-stock exposure. Calls are netted within each underlying and expiry;
  long calls at other expiries are not assumed to guarantee protection. Flags
  are conservative when expiries differ.

For mixed expiries, terminal payoff assumes the same relative move at each
contract's own expiry. It is not the value of a portfolio liquidated on one date,
nor a simulation of intermediate cash flows or assignment. The pre-expiry curve
provides the common-horizon estimate.

The model follows the inputs and limitations described by the
[Options Industry Council](https://www.optionseducation.org/advancedconcepts/black-scholes-formula).
It does not model early exercise, assignment, discrete dividends, volatility
skew, fees, financing cash flows or liquidity. It is not calibrated to broker
marks or implied volatility. American options are approximated as European.

## Coverage and failure states

Supported instruments are `STK` and standard `OPT` contracts. Futures, futures
options, bonds, combinations and other security types are listed as excluded.
Missing/invalid option terms, multipliers, quantities, costs or currencies and
past expiries are also excluded explicitly. The current feed does not identify
adjusted deliverables, so the model assumes standard option deliverables and
that symbol plus currency identifies an underlying.

Missing reference prices or invalid assumptions prevent curves from appearing.
If any account's position request is pending or fails, no partial desk curve is
shown. Unsupported legs are listed with reasons and included/excluded counts;
curves with exclusions are partial coverage, not a complete desk risk measure.
If chart rendering fails, the scenario table remains available.

Tests cover reference option prices, put-call parity, expiry and zero-volatility
boundaries, multipliers, short positions, vertical spreads, account aggregation,
tail flags, exclusions, currency separation and loading/error behavior.

The Next.js configuration uses the documented TypeScript compiler API fallback
(`experimental.useTypeScriptCli: false`) with TypeScript 6 because the default
CLI path failed to capture `--showConfig` output in this environment. Production
builds still perform type checking.
