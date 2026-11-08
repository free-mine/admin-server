// Ошибки используемых операций Aave V3 Origin:
// https://github.com/aave/aave-v3-origin/blob/main/src/contracts/protocol/libraries/helpers/Errors.sol
export const aaveErrorsAbi = [
  'error SupplyCapExceeded()',
  'error BorrowCapExceeded()',
  'error ReserveFrozen()',
  'error ReservePaused()',
  'error ReserveInactive()',
  'error InvalidAmount()',
  'error BorrowingNotEnabled()',
  'error NotEnoughAvailableUserBalance()',
  'error CollateralBalanceIsZero()',
  'error HealthFactorLowerThanLiquidationThreshold()',
  'error CollateralCannotCoverNewBorrow()',
  'error DebtCeilingExceeded()',
  'error NoDebtOfSelectedType()',
  'error AssetNotBorrowableInIsolation()',
  'error NotBorrowableInEMode()',
  'error UserInIsolationModeOrLtvZero()',
  'error PriceOracleSentinelCheckFailed()',
  'error InvalidInterestRateModeSelected()',
]
