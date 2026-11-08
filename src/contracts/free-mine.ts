export const freeMineAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "initialPrice",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "initialDollar",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "ore",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "name": "ClaimNotFound",
    "type": "error",
    "inputs": [
      {
        "name": "shiftId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "claimId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "EntryPriceUpdateOutOfRange",
    "type": "error",
    "inputs": []
  },
  {
    "name": "EntryPriceUpdateTooEarly",
    "type": "error",
    "inputs": []
  },
  {
    "name": "ExpirationTooEarly",
    "type": "error",
    "inputs": [
      {
        "name": "cancelableAt",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "InsufficientQuantity",
    "type": "error",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "NewDollarIsMagicOre",
    "type": "error",
    "inputs": []
  },
  {
    "name": "OwnableInvalidOwner",
    "type": "error",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "name": "OwnableUnauthorizedAccount",
    "type": "error",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "name": "OwnerCannotBuy",
    "type": "error",
    "inputs": []
  },
  {
    "name": "PriceIsTooHigh",
    "type": "error",
    "inputs": [
      {
        "name": "maxPrice",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "PriceIsTooLow",
    "type": "error",
    "inputs": [
      {
        "name": "minPrice",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "SafeERC20FailedOperation",
    "type": "error",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "name": "SenderIsNotMiner",
    "type": "error",
    "inputs": []
  },
  {
    "name": "ShiftClosingIsBlocked",
    "type": "error",
    "inputs": []
  },
  {
    "name": "ShiftIsNotClosed",
    "type": "error",
    "inputs": []
  },
  {
    "name": "ShiftIsNotFunded",
    "type": "error",
    "inputs": [
      {
        "name": "shiftId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "TooBigDollarDecimals",
    "type": "error",
    "inputs": [
      {
        "name": "decimals",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "Bought",
    "type": "event",
    "inputs": [
      {
        "name": "buyer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "dollar",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "ore",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "ClaimClosed",
    "type": "event",
    "inputs": [
      {
        "name": "cancelled",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "miner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "shiftId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "claimId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "ClaimOpened",
    "type": "event",
    "inputs": [
      {
        "name": "oreAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "miner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "shiftId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "claimId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "DollarChanged",
    "type": "event",
    "inputs": [
      {
        "name": "dollar",
        "type": "address",
        "indexed": true,
        "internalType": "contract IDollar"
      },
      {
        "name": "decimals",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "EntryPriceUpdated",
    "type": "event",
    "inputs": [
      {
        "name": "oldPrice",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "newPrice",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "OwnershipTransferred",
    "type": "event",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "name": "Sacrificed",
    "type": "event",
    "inputs": [
      {
        "name": "miner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "oreAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "ShiftClosed",
    "type": "event",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "ShiftFunded",
    "type": "event",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "buy",
    "type": "function",
    "inputs": [
      {
        "name": "dollarAmount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "cancelClaim",
    "type": "function",
    "inputs": [
      {
        "name": "shiftId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "claimId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "changeDollar",
    "type": "function",
    "inputs": [
      {
        "name": "newDollar",
        "type": "address",
        "internalType": "contract IDollar"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "closeShift",
    "type": "function",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "currentShiftId",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "dollar",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IDollar"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "entryPrice",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "expireClaim",
    "type": "function",
    "inputs": [
      {
        "name": "shiftId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "claimId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "fundShift",
    "type": "function",
    "inputs": [
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "getClaim",
    "type": "function",
    "inputs": [
      {
        "name": "shiftId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "claimId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "miner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "oreAmount",
            "type": "uint256",
            "internalType": "uint256"
          }
        ],
        "internalType": "struct FreeMine.Claim"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "magicOre",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IMagicOre"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "openClaim",
    "type": "function",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "owner",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "priceUpdatedAt",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "redeemClaim",
    "type": "function",
    "inputs": [
      {
        "name": "shiftId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "claimId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "renounceOwnership",
    "type": "function",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "sacrifice",
    "type": "function",
    "inputs": [
      {
        "name": "oreAmount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "shifts",
    "type": "function",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "funded",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "dollar",
        "type": "address",
        "internalType": "contract IDollar"
      },
      {
        "name": "fundedAt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "oreAmount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "dollarScale",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "currentClaimId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "transferOwnership",
    "type": "function",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "updateEntryPrice",
    "type": "function",
    "inputs": [
      {
        "name": "newPrice",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  }
]
