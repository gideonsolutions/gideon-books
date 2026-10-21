# Payroll import format (version 1)

Gideon Books posts payroll that a payroll provider calculated. It does not calculate payroll taxes or file payroll returns. Each file holds **one payroll run**. Amounts are decimal strings in the organization's base currency with at most its minor units (two places for USD); thousands separators, a `$` sign and `(1.00)` for negatives are accepted in CSV. Dates are `YYYY-MM-DD`.

## Components

| type | what it is | posts |
|---|---|---|
| `gross_wages` | earnings (regular, overtime, bonus, commission…) | Dr expense |
| `employee_withholding` | taxes withheld from pay (federal income tax, social security, medicare, state, local, other) | Cr liability |
| `employee_deduction` | other deductions from pay (benefit premiums, retirement, garnishments) | Cr liability |
| `employer_tax` | employer payroll taxes (social security, medicare, FUTA, SUTA…) | Dr expense, Cr liability |
| `employer_benefit` | employer benefit contributions | Dr expense, Cr liability |
| `reimbursement` | expense reimbursements paid with the paycheck | Dr expense |
| `net_pay` | what the employee received | Cr net pay clearing (or a bank account) |

Each component has a **code** (lowercase letters, digits, `.`, `-`, `_`), e.g. `regular`, `federal_income_tax`. Codes choose the account through **Payroll → Mappings**; a component without its own mapping uses its type's default.

**The check:** for every employee (or the whole run, for a summary file), gross − withholdings − deductions + reimbursements = net pay, exactly. A file that fails it is refused with the employee and the difference.

## Employee-level CSV

One row per employee. Required columns: `run_id`, `pay_date`, `period_start`, `period_end`, `employee_id`, `net_pay`. Optional: `employee_name`, `department`, `class`, `location`, `project` (the name or code of a value that exists in the organization). Amount columns are named `<prefix>:<code>`:

| prefix | type |
|---|---|
| `gross:` | `gross_wages` |
| `withholding:` | `employee_withholding` |
| `deduction:` | `employee_deduction` |
| `employer_tax:` | `employer_tax` |
| `employer_benefit:` | `employer_benefit` |
| `reimbursement:` | `reimbursement` |

Blank cells are zero. Every row must carry the same `run_id` and `pay_date`.

```csv
run_id,pay_date,period_start,period_end,employee_id,employee_name,department,gross:regular,gross:overtime,withholding:federal_income_tax,withholding:social_security,withholding:medicare,deduction:health,employer_tax:social_security,employer_tax:medicare,employer_tax:futa,employer_benefit:health,reimbursement:mileage,net_pay
PR-2026-01,2026-01-31,2026-01-01,2026-01-31,E1,"Lovelace, Ada",,"4,000.00",200.00,500.00,260.40,60.90,100.00,260.40,60.90,24.00,300.00,45.50,3324.20
PR-2026-01,2026-01-31,2026-01-01,2026-01-31,E2,Grace Hopper,,3000.00,,300.00,186.00,43.50,50.00,186.00,43.50,18.00,200.00,,2420.50
```

## Summary CSV

When per-employee detail is not wanted: one row per component, columns `run_id`, `pay_date`, `period_start`, `period_end`, `component_type`, `component_code`, `amount`, optional `department`, `class`, `location`, `project`. For `net_pay`, the code may be blank.

```csv
run_id,pay_date,period_start,period_end,component_type,component_code,amount
S-2026-03,2026-03-31,2026-03-01,2026-03-31,gross_wages,regular,5000.00
S-2026-03,2026-03-31,2026-03-01,2026-03-31,employee_withholding,federal_income_tax,600.00
S-2026-03,2026-03-31,2026-03-01,2026-03-31,net_pay,,4400.00
```

## JSON

Amounts must be **strings** (JSON numbers are refused so no precision is lost).

```json
{
  "run_id": "PR-2026-02",
  "pay_date": "2026-02-15",
  "period_start": "2026-02-01",
  "period_end": "2026-02-15",
  "employees": [
    {
      "employee_id": "E1",
      "name": "Ada Lovelace",
      "department": "Engineering",
      "earnings": { "regular": "1000.00" },
      "withholdings": { "federal_income_tax": "100.00" },
      "deductions": {},
      "employer_taxes": { "medicare": "14.50" },
      "employer_benefits": {},
      "reimbursements": {},
      "net_pay": "900.00"
    }
  ]
}
```

A summary in JSON uses `"components": [{ "type": "gross_wages", "code": "regular", "amount": "5000.00", "department": "…" }, …]` instead of `employees`.

## Duplicates and corrections

A run is identified by the import format and its `run_id`, and a file by its SHA-256. Neither can be posted twice while the earlier run stands; the import page links to the run already posted. To correct a run, **void** it (its entry is reversed, with a reason; recorded net pay and liability payments must be voided first) and import the corrected file — or import an adjustment run with its own `run_id`.

## Adding a provider adapter

An adapter implements `PayrollAdapter` (`lib/payroll/adapters.ts`): a key, a label, the file types it accepts, and `parse(content)` returning the normalized run (component rows with type, code, amount, employee and dimensions) or the problems found. Add it to `ADAPTERS`. Provider-specific adapters (Gusto, ADP, Paychex…) are **not** included: their export layouts could not be verified here, and an adapter built on a guessed layout would post wrong figures. Convert the provider's payroll register to this format instead.
