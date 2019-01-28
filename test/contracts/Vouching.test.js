require('../setup')

import timeTravel from '../../src/helpers/timeTravel'
import { Contracts, encodeCall, assertEvent, assertRevert } from 'zos-lib'

const BN = web3.BigNumber
const ZEPToken = artifacts.require('ZEPToken')
const Vouching = artifacts.require('Vouching')
const DependencyMock = artifacts.require('DependencyMock')
const BasicJurisdiction = Contracts.getFromNodeModules('tpl-contracts-eth', 'BasicJurisdiction')
const OrganizationsValidator = Contracts.getFromNodeModules('tpl-contracts-eth', 'OrganizationsValidator')

const zep = x => new BN(`${x}e18`)
const pct = x => new BN(`${x}e16`)

contract('Vouching', function ([anyone, tokenOwner, voucher, entryOwner, transferee, challenger, jurisdictionOwner, validatorOwner, organization, overseer]) {
  const ZEP_BALANCE = zep(10000000)
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

  const PCT_BASE = pct(100) // 100 %
  const APPEAL_FEE = pct(1) // 1 %
  const MINIMUM_STAKE = zep(10)

  const METADATA_URI = 'uri'
  const METADATA_HASH = '0x2a00000000000000000000000000000000000000000000000000000000000000'

  const ANSWER = { 0: 'PENDING', 1: 'ACCEPTED', 2: 'REJECTED' }
  const RESOLUTION = { 0: 'PENDING', 1: 'SUSTAINED', 2: 'OVERRULED', 3: 'CONFIRMED' }

  const ANSWER_WINDOW_SECONDS = 7 * 60 * 60 * 24 // 7 days
  const APPEAL_WINDOW_SECONDS = 9 * 60 * 60 * 24 // 9 days

  before('TPL setup', async function () {
    // Initialize Jurisdiction
    this.jurisdiction = await BasicJurisdiction.new({ from: jurisdictionOwner })
    const initializeJurisdictionData = encodeCall('initialize', ['address'], [jurisdictionOwner])
    await this.jurisdiction.sendTransaction({ data: initializeJurisdictionData })

    // Initialize ZEPToken
    const attributeID = 0
    this.token = await ZEPToken.new()
    const initializeZepData = encodeCall('initialize', ['address', 'address', 'uint256'], [tokenOwner, this.jurisdiction.address, attributeID])
    await this.token.sendTransaction({ data: initializeZepData })

    // Initialize Validator
    this.validator = await OrganizationsValidator.new()
    const initializeValidatorData = encodeCall('initialize', ['address', 'uint256', 'address'], [this.jurisdiction.address, attributeID, validatorOwner])
    await this.validator.sendTransaction({ data: initializeValidatorData })

    // Issue TPL attributes
    await this.jurisdiction.addValidator(this.validator.address, 'ZEP Validator', { from: jurisdictionOwner })
    await this.jurisdiction.addAttributeType(attributeID, 'can receive', { from: jurisdictionOwner })
    await this.jurisdiction.addValidatorApproval(this.validator.address, attributeID, { from: jurisdictionOwner })
    await this.validator.addOrganization(organization, 100000, 'ZEP Org', { from: validatorOwner })
    await this.validator.issueAttribute(tokenOwner, { from: organization })
    await this.validator.issueAttribute(anyone, { from: organization })
    await this.validator.issueAttribute(voucher, { from: organization })
    await this.validator.issueAttribute(challenger, { from: organization })
    await this.validator.issueAttribute(entryOwner, { from: organization })

    // Transfer ZEP tokens
    await this.token.transfer(anyone, ZEP_BALANCE, { from: tokenOwner })
    await this.token.transfer(voucher, ZEP_BALANCE, { from: tokenOwner })
    await this.token.transfer(challenger, ZEP_BALANCE, { from: tokenOwner })
    await this.token.transfer(entryOwner, ZEP_BALANCE, { from: tokenOwner })

    // Create entry for vouching
    this.entryAddress = (await DependencyMock.new()).address
  })

  beforeEach('initialize vouching', async function () {
    // Initialize vouching contract
    this.vouching = await Vouching.new()
    await this.vouching.initialize(this.token.address, MINIMUM_STAKE, APPEAL_FEE, overseer)
    await this.validator.issueAttribute(this.vouching.address, { from: organization })

    // Approve ZEP tokens to the vouching contract for testing purpose
    await this.token.approve(this.vouching.address, ZEP_BALANCE, { from: anyone })
    await this.token.approve(this.vouching.address, ZEP_BALANCE, { from: voucher })
    await this.token.approve(this.vouching.address, ZEP_BALANCE, { from: challenger })
    await this.token.approve(this.vouching.address, ZEP_BALANCE, { from: entryOwner })
  })

  describe('initialize', function () {
    it('stores the token address', async function () {
      (await this.vouching.token()).should.equal(this.token.address)
    })

    it('stores the minimum stake', async function () {
      (await this.vouching.minimumStake()).should.be.bignumber.equal(MINIMUM_STAKE)
    })

    it('requires a non-null token', async function () {
      const vouching = await Vouching.new({ from: voucher })
      await assertRevert(vouching.initialize(ZERO_ADDRESS, MINIMUM_STAKE, APPEAL_FEE, overseer, { from: voucher }))
    })

    it('requires an appeal fee not greater than 100%', async function () {
      const vouching = await Vouching.new({ from: voucher })
      await assertRevert(vouching.initialize(this.token.address, MINIMUM_STAKE, pct(101), overseer, { from: voucher }))
    })
  })

  describe('register', function () {
    const from = entryOwner

    context('when the given amount is more than the minimum stake', function () {
      const vouched = zep(1)
      const amount = MINIMUM_STAKE.plus(vouched)

      context('when the given entry address is a contract', function () {
        it('stores the new entry', async function () {
          const receipt = await this.vouching.register(this.entryAddress, amount, METADATA_URI, METADATA_HASH, { from })
          const id = receipt.logs[0].args.id

          const entryAddress = await this.vouching.addr(id)
          entryAddress.should.equal(this.entryAddress)

          const owner = await this.vouching.owner(id)
          owner.should.equal(entryOwner)

          const minimumStake = await this.vouching.minStake(id)
          minimumStake.should.be.bignumber.equal(MINIMUM_STAKE)
        })

        it('sets the vouched, available and blocked amounts properly', async function () {
          const receipt = await this.vouching.register(this.entryAddress, amount, METADATA_URI, METADATA_HASH, { from })
          const id = receipt.logs[0].args.id

          const vouchedAmount = await this.vouching.vouched(id, from)
          vouchedAmount.should.be.bignumber.equal(vouched)

          const totalVouched = await this.vouching.totalVouched(id)
          totalVouched.should.be.bignumber.equal(vouched)

          const availableAmount = await this.vouching.available(id, from)
          availableAmount.should.be.bignumber.equal(vouched)

          const totalAvailable = await this.vouching.totalAvailable(id)
          totalAvailable.should.be.bignumber.equal(vouched)

          const blockedAmount = await this.vouching.blocked(id, from)
          blockedAmount.should.be.bignumber.equal(0)

          const totalBlocked = await this.vouching.totalBlocked(id)
          totalBlocked.should.be.bignumber.equal(0)
        })

        it('emits a Registered and Vouched events', async function () {
          const receipt = await this.vouching.register(this.entryAddress, amount, METADATA_URI, METADATA_HASH, { from })

          const registeredEvent = assertEvent.inLogs(receipt.logs, 'Registered')
          registeredEvent.args.id.should.be.bignumber.eq(0)
          registeredEvent.args.addr.should.be.eq(this.entryAddress)
          registeredEvent.args.owner.should.be.eq(from)
          registeredEvent.args.minimumStake.should.be.bignumber.eq(MINIMUM_STAKE)
          registeredEvent.args.metadataURI.should.be.eq(METADATA_URI)
          registeredEvent.args.metadataHash.should.be.eq(METADATA_HASH)

          const vouchedEvent = assertEvent.inLogs(receipt.logs, 'Vouched')
          vouchedEvent.args.id.should.be.bignumber.eq(0)
          vouchedEvent.args.sender.should.be.eq(from)
          vouchedEvent.args.amount.should.be.bignumber.eq(vouched)
        })

        it('transfers the token amount to the vouching contract', async function () {
          const previousSenderBalance = await this.token.balanceOf(from)
          const previousVouchingBalance = await this.token.balanceOf(this.vouching.address)

          await this.vouching.register(this.entryAddress, amount, METADATA_URI, METADATA_HASH, { from })

          const currentSenderBalance = await this.token.balanceOf(from)
          currentSenderBalance.should.be.bignumber.equal(previousSenderBalance.minus(amount))

          const currentVouchingBalance = await this.token.balanceOf(this.vouching.address)
          currentVouchingBalance.should.be.bignumber.equal(previousVouchingBalance.plus(amount))
        })
      })

      context('when the given entry address is the zero address', function () {
        it('reverts', async function () {
          await assertRevert(this.vouching.register(ZERO_ADDRESS, amount, METADATA_URI, METADATA_HASH, { from }))
        })
      })
    })

    context('when the given amount is equal to the minimum stake', function () {
      const amount = MINIMUM_STAKE

      context('when the given entry address is a contract', function () {
        it('stores the new entry', async function () {
          const receipt = await this.vouching.register(this.entryAddress, amount, METADATA_URI, METADATA_HASH, { from })
          const id = receipt.logs[0].args.id

          const entryAddress = await this.vouching.addr(id)
          entryAddress.should.equal(this.entryAddress)

          const owner = await this.vouching.owner(id)
          owner.should.equal(entryOwner)

          const minimumStake = await this.vouching.minStake(id)
          minimumStake.should.be.bignumber.equal(MINIMUM_STAKE)
        })

        it('sets the vouched, available and blocked amounts properly', async function () {
          const receipt = await this.vouching.register(this.entryAddress, amount, METADATA_URI, METADATA_HASH, { from })
          const id = receipt.logs[0].args.id

          const vouchedAmount = await this.vouching.vouched(id, from)
          vouchedAmount.should.be.bignumber.equal(0)

          const totalVouched = await this.vouching.totalVouched(id)
          totalVouched.should.be.bignumber.equal(0)

          const availableAmount = await this.vouching.available(id, from)
          availableAmount.should.be.bignumber.equal(0)

          const totalAvailable = await this.vouching.totalAvailable(id)
          totalAvailable.should.be.bignumber.equal(0)

          const blockedAmount = await this.vouching.blocked(id, from)
          blockedAmount.should.be.bignumber.equal(0)

          const totalBlocked = await this.vouching.totalBlocked(id)
          totalBlocked.should.be.bignumber.equal(0)
        })

        it('emits a Registered event', async function () {
          const receipt = await this.vouching.register(this.entryAddress, amount, METADATA_URI, METADATA_HASH, { from })

          const event = assertEvent.inLogs(receipt.logs, 'Registered')
          event.args.id.should.be.bignumber.eq(0)
          event.args.addr.should.be.eq(this.entryAddress)
          event.args.owner.should.be.eq(from)
          event.args.minimumStake.should.be.bignumber.eq(MINIMUM_STAKE)
          event.args.metadataURI.should.be.eq(METADATA_URI)
          event.args.metadataHash.should.be.eq(METADATA_HASH)
        })

        it('transfers the token amount to the vouching contract', async function () {
          const previousSenderBalance = await this.token.balanceOf(from)
          const previousVouchingBalance = await this.token.balanceOf(this.vouching.address)

          await this.vouching.register(this.entryAddress, amount, METADATA_URI, METADATA_HASH, { from })

          const currentSenderBalance = await this.token.balanceOf(from)
          currentSenderBalance.should.be.bignumber.equal(previousSenderBalance.minus(amount))

          const currentVouchingBalance = await this.token.balanceOf(this.vouching.address)
          currentVouchingBalance.should.be.bignumber.equal(previousVouchingBalance.plus(amount))
        })
      })

      context('when the given entry address is the zero address', function () {
        it('reverts', async function () {
          await assertRevert(this.vouching.register(ZERO_ADDRESS, amount, METADATA_URI, METADATA_HASH, { from }))
        })
      })
    })

    context('when the given amount is less than the minimum stake', function () {
      const amount = MINIMUM_STAKE.minus(1)

      it('reverts', async function () {
        await assertRevert(this.vouching.register(this.entryAddress, amount, METADATA_URI, METADATA_HASH, { from }))
      })
    })
  })

  describe('vouch', function () {
    const from = voucher

    context('when the entry id exists', function () {
      beforeEach('register a new entry', async function () {
        const receipt = await this.vouching.register(this.entryAddress, MINIMUM_STAKE.times(2), METADATA_URI, METADATA_HASH, { from: entryOwner })
        this.id = receipt.logs[0].args.id
      })

      context('when the amount does not exceed the current balance', function () {
        const amount = zep(1)

        const itShouldHandleVouchesProperly = function () {
          it('emits a Vouched event', async function () {
            const receipt = await this.vouching.vouch(this.id, amount, { from })

            const event = assertEvent.inLogs(receipt.logs, 'Vouched')
            event.args.id.should.be.bignumber.eq(this.id)
            event.args.sender.should.be.eq(from)
            event.args.amount.should.be.bignumber.eq(amount)
          })

          it('updates the vouched and available amounts properly', async function () {
            const previousVouched = await this.vouching.vouched(this.id, from)
            const previousTotalVouched = await this.vouching.totalVouched(this.id)
            const previousAvailable = await this.vouching.available(this.id, from)
            const previousTotalAvailable = await this.vouching.totalAvailable(this.id)

            await this.vouching.vouch(this.id, amount, { from })

            const vouchedAmount = await this.vouching.vouched(this.id, from)
            vouchedAmount.should.be.bignumber.equal(previousVouched.plus(amount))

            const totalVouched = await this.vouching.totalVouched(this.id)
            totalVouched.should.be.bignumber.equal(previousTotalVouched.plus(amount))

            const availableAmount = await this.vouching.available(this.id, from)
            availableAmount.should.be.bignumber.equal(previousAvailable.plus(amount))

            const totalAvailable = await this.vouching.totalAvailable(this.id)
            totalAvailable.should.be.bignumber.equal(previousTotalAvailable.plus(amount))
          })

          it('does not update the blocked amount', async function () {
            const previousBlocked = await this.vouching.blocked(this.id, from)
            const previousTotalBlocked = await this.vouching.totalBlocked(this.id)

            await this.vouching.vouch(this.id, amount, { from })

            const blockedAmount = await this.vouching.blocked(this.id, from)
            blockedAmount.should.be.bignumber.equal(previousBlocked)

            const totalBlocked = await this.vouching.totalBlocked(this.id)
            totalBlocked.should.be.bignumber.equal(previousTotalBlocked)
          })

          it('transfers the amount of tokens to the vouching contract', async function () {
            const previousSenderBalance = await this.token.balanceOf(from)
            const previousVouchingBalance = await this.token.balanceOf(this.vouching.address)

            await this.vouching.vouch(this.id, amount, { from })

            const currentSenderBalance = await this.token.balanceOf(from)
            currentSenderBalance.should.be.bignumber.equal(previousSenderBalance.minus(amount))

            const currentVouchingBalance = await this.token.balanceOf(this.vouching.address)
            currentVouchingBalance.should.be.bignumber.equal(previousVouchingBalance.plus(amount))
          })
        }

        context('when there was no ongoing challenges', function () {
          context('when there was no previous challenge', function () {
            itShouldHandleVouchesProperly()
          })

          context('when there was a previous challenge', function () {
            context('when there was an accepted previous challenge', function () {
              beforeEach('pay a previous accepted challenge', async function () {
                const receipt = await this.vouching.challenge(this.id, pct(1), 'challenge uri', '0x3a', { from: challenger })
                const challengeID = receipt.logs[0].args.challengeID

                await this.vouching.accept(challengeID, { from: entryOwner })
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(challengeID)
              })

              itShouldHandleVouchesProperly()
            })

            context('when there was a rejected previous challenge', function () {
              beforeEach('charge a previous rejected challenge', async function () {
                const receipt = await this.vouching.challenge(this.id, pct(1), 'challenge uri', '0x3a', { from: challenger })
                const challengeID = receipt.logs[0].args.challengeID

                await this.vouching.reject(challengeID, { from: entryOwner })
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(challengeID)
              })

              itShouldHandleVouchesProperly()
            })
          })
        })

        context('when there was an ongoing challenges', function () {
          beforeEach('create challenge', async function () {
            await this.vouching.challenge(this.id, pct(1), 'challenge uri', '0x3a', { from: challenger })
          })

          context('when there was no previous challenge', function () {
            itShouldHandleVouchesProperly()
          })

          context('when there was a previous challenge', function () {
            context('when there was an accepted previous challenge', function () {
              beforeEach('pay a previous accepted challenge', async function () {
                const receipt = await this.vouching.challenge(this.id, pct(1), 'challenge uri', '0x3a', { from: challenger })
                const challengeID = receipt.logs[0].args.challengeID

                await this.vouching.accept(challengeID, { from: entryOwner })
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(challengeID)
              })

              itShouldHandleVouchesProperly()
            })

            context('when there was a rejected previous challenge', function () {
              beforeEach('charge a previous rejected challenge', async function () {
                const receipt = await this.vouching.challenge(this.id, pct(1), 'challenge uri', '0x3a', { from: challenger })
                const challengeID = receipt.logs[0].args.challengeID

                await this.vouching.reject(challengeID, { from: entryOwner })
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(challengeID)
              })

              itShouldHandleVouchesProperly()
            })
          })
        })
      })

      context('when the amount exceeds the current balance', function () {
        const amount = ZEP_BALANCE.plus(1)

        it('reverts', async function () {
          await assertRevert(this.vouching.vouch(this.id, amount, { from }))
        })
      })
    })

    context('when the entry id does not exist', function () {
      it('reverts when caller is not the entry owner', async function () {
        await assertRevert(this.vouching.vouch(1, zep(1), { from }))
      })
    })
  })

  describe('unvouch', function () {
    const from = voucher

    context('when the entry id exists', function () {
      beforeEach('register a new entry', async function () {
        const receipt = await this.vouching.register(this.entryAddress, MINIMUM_STAKE.times(2), METADATA_URI, METADATA_HASH, { from: entryOwner })
        this.id = receipt.logs[0].args.id
      })

      context('when the sender has already vouched some tokens', function () {
        const vouchedAmount = zep(10)

        beforeEach('vouch some tokens', async function () {
          await this.vouching.vouch(this.id, vouchedAmount, { from })
        })

        const itShouldHandleUnvouchesProperly = function () {
          it('emits an Unvouched event', async function () {
            const receipt = await this.vouching.unvouch(this.id, this.amount, { from })

            const event = assertEvent.inLogs(receipt.logs, 'Unvouched')
            event.args.id.should.be.bignumber.eq(this.id)
            event.args.sender.should.be.eq(from)
            event.args.amount.should.be.bignumber.eq(this.amount)
          })

          it('updates the vouched and available amounts properly', async function () {
            const previousVouched = await this.vouching.vouched(this.id, from)
            const previousTotalVouched = await this.vouching.totalVouched(this.id)
            const previousAvailable = await this.vouching.available(this.id, from)
            const previousTotalAvailable = await this.vouching.totalAvailable(this.id)

            await this.vouching.unvouch(this.id, this.amount, { from })

            const vouchedAmount = await this.vouching.vouched(this.id, from)
            vouchedAmount.should.be.bignumber.equal(previousVouched.minus(this.amount))

            const totalVouched = await this.vouching.totalVouched(this.id)
            totalVouched.should.be.bignumber.equal(previousTotalVouched.minus(this.amount))

            const availableAmount = await this.vouching.available(this.id, from)
            availableAmount.should.be.bignumber.equal(previousAvailable.minus(this.amount))

            const totalAvailable = await this.vouching.totalAvailable(this.id)
            totalAvailable.should.be.bignumber.equal(previousTotalAvailable.minus(this.amount))
          })

          it('does not update the blocked amount', async function () {
            const previousBlocked = await this.vouching.blocked(this.id, from)
            const previousTotalBlocked = await this.vouching.totalBlocked(this.id)

            await this.vouching.unvouch(this.id, this.amount, { from })

            const blockedAmount = await this.vouching.blocked(this.id, from)
            blockedAmount.should.be.bignumber.equal(previousBlocked)

            const totalBlocked = await this.vouching.totalBlocked(this.id)
            totalBlocked.should.be.bignumber.equal(previousTotalBlocked)
          })

          it('transfers the requested amount of tokens to the sender', async function () {
            const previousSenderBalance = await this.token.balanceOf(from)
            const previousVouchingBalance = await this.token.balanceOf(this.vouching.address)

            await this.vouching.unvouch(this.id, this.amount, { from })

            const currentSenderBalance = await this.token.balanceOf(from)
            currentSenderBalance.should.be.bignumber.equal(previousSenderBalance.plus(this.amount))

            const currentVouchingBalance = await this.token.balanceOf(this.vouching.address)
            currentVouchingBalance.should.be.bignumber.equal(previousVouchingBalance.minus(this.amount))
          })
        }

        context('when there was no ongoing challenges', function () {
          context('when there was no previous challenge', function () {
            context('when the amount does not exceed the available amount', function () {
              beforeEach('set amount', async function () {
                this.amount = vouchedAmount
              })

              itShouldHandleUnvouchesProperly()
            })

            context('when the amount exceeds the available amount', function () {
              const amount = vouchedAmount.plus(1)

              it('reverts', async function () {
                await assertRevert(this.vouching.unvouch(this.id, amount, { from }))
              })
            })
          })

          context('when there was a previous challenge', function () {
            context('when there was an accepted previous challenge', function () {
              beforeEach('pay a previous accepted challenge', async function () {
                const receipt = await this.vouching.challenge(this.id, pct(1), 'challenge uri', '0x3a', {from: challenger})
                const challengeID = receipt.logs[0].args.challengeID

                await this.vouching.accept(challengeID, {from: entryOwner})
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(challengeID)
              })

              context('when the amount does not exceed the available amount', function () {
                beforeEach('set amount', async function () {
                  this.amount = await this.vouching.available(this.id, from)
                })

                itShouldHandleUnvouchesProperly()
              })

              context('when the amount exceeds the available amount', function () {
                beforeEach('set amount', async function () {
                  this.amount = (await this.vouching.available(this.id, from)).plus(1)
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.unvouch(this.id, this.amount, { from }))
                })
              })
            })

            context('when there was a rejected previous challenge', function () {
              beforeEach('charge a previous rejected challenge', async function () {
                const receipt = await this.vouching.challenge(this.id, pct(1), 'challenge uri', '0x3a', { from: challenger })
                const challengeID = receipt.logs[0].args.challengeID

                await this.vouching.reject(challengeID, { from: entryOwner })
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(challengeID)
              })

              context('when the amount does not exceed the available amount', function () {
                beforeEach('set amount', async function () {
                  this.amount = await this.vouching.available(this.id, from)
                })

                itShouldHandleUnvouchesProperly()
              })

              context('when the amount exceeds the available amount', function () {
                beforeEach('set amount', async function () {
                  this.amount = (await this.vouching.available(this.id, from)).plus(1)
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.unvouch(this.id, this.amount, { from }))
                })
              })
            })
          })
        })

        context('when there was an ongoing challenges', function () {
          beforeEach('create challenge', async function () {
            await this.vouching.challenge(this.id, pct(1), 'challenge uri', '0x3a', { from: challenger })
          })

          context('when there was no previous challenge', function () {
            context('when the amount does not exceed the available amount', function () {
              beforeEach('set amount', async function () {
                this.amount = await this.vouching.available(this.id, from)
              })

              itShouldHandleUnvouchesProperly()
            })

            context('when the amount exceeds the available amount', function () {
              beforeEach('set amount', async function () {
                this.amount = (await this.vouching.available(this.id, from)).plus(1)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.unvouch(this.id, this.amount, { from }))
              })
            })
          })

          context('when there was a previous challenge', function () {
            context('when there was an accepted previous challenge', function () {
              beforeEach('pay a previous accepted challenge', async function () {
                const receipt = await this.vouching.challenge(this.id, pct(1), 'challenge uri', '0x3a', { from: challenger })
                const challengeID = receipt.logs[0].args.challengeID

                await this.vouching.accept(challengeID, { from: entryOwner })
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(challengeID)
              })

              context('when the amount does not exceed the available amount', function () {
                beforeEach('set amount', async function () {
                  this.amount = await this.vouching.available(this.id, from)
                })

                itShouldHandleUnvouchesProperly()
              })

              context('when the amount exceeds the available amount', function () {
                beforeEach('set amount', async function () {
                  this.amount = (await this.vouching.available(this.id, from)).plus(1)
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.unvouch(this.id, this.amount, { from }))
                })
              })
            })

            context('when there was a rejected previous challenge', function () {
              beforeEach('charge a previous rejected challenge', async function () {
                const receipt = await this.vouching.challenge(this.id, pct(1), 'challenge uri', '0x3a', { from: challenger })
                const challengeID = receipt.logs[0].args.challengeID

                await this.vouching.reject(challengeID, { from: entryOwner })
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(challengeID)
              })

              context('when the amount does not exceed the available amount', function () {
                beforeEach('set amount', async function () {
                  this.amount = await this.vouching.available(this.id, from)
                })

                itShouldHandleUnvouchesProperly()
              })

              context('when the amount exceeds the available amount', function () {
                beforeEach('set amount', async function () {
                  this.amount = (await this.vouching.available(this.id, from)).plus(1)
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.unvouch(this.id, this.amount, { from }))
                })
              })
            })
          })
        })
      })

      context('when the sender does not have vouched tokens', function () {
        const amount = 1

        it('reverts', async function () {
          await assertRevert(this.vouching.unvouch(this.id, amount, { from }))
        })
      })
    })

    context('when the entry id does not exist', function () {
      it('reverts', async function () {
        await assertRevert(this.vouching.unvouch(1, 1, { from: voucher }))
      })
    })
  })

  describe('challenge', function () {
    const CHALLENGE_METADATA_URI = 'challenge uri'
    const CHALLENGE_METADATA_HASH = '0x3a00000000000000000000000000000000000000000000000000000000000001'

    context('when the entry id exists', function () {
      beforeEach('register an entry', async function () {
        const receipt = await this.vouching.register(this.entryAddress, MINIMUM_STAKE, METADATA_URI, METADATA_HASH, { from: entryOwner })
        this.id = receipt.logs[0].args.id
      })

      context('when the sender is not the owner of the entry', function () {
        const from = challenger

        context('when the are some tokens vouched for the given entry', function () {
          beforeEach('vouch some tokens', async function () {
            await this.vouching.vouch(this.id, zep(5), { from: voucher })
            await this.vouching.vouch(this.id, zep(10), { from: entryOwner })
          })

          context('when the given fee is valid', function () {
            const CHALLENGE_FEE = pct(1)

            const itShouldHandleChallengesProperly = function () {
              beforeEach('calculate challenge amount', async function () {
                const totalAvailable = await this.vouching.totalAvailable(this.id)
                this.challengeAmount = totalAvailable.times(CHALLENGE_FEE).div(PCT_BASE)
              })

              it('emits a Challenged event', async function () {
                const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from })

                const event = assertEvent.inLogs(receipt.logs, 'Challenged')
                event.args.id.should.be.bignumber.eq(this.id)
                event.args.challengeID.should.not.be.null
                event.args.challenger.should.be.bignumber.eq(from)
                event.args.amount.should.be.bignumber.eq(this.challengeAmount)
                event.args.metadataURI.should.be.eq(CHALLENGE_METADATA_URI)
                event.args.metadataHash.should.be.eq(CHALLENGE_METADATA_HASH)
              })

              it('stores the created challenge', async function () {
                const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from })
                const challengeID = receipt.logs[0].args.challengeID

                const challengeTarget = await this.vouching.challengeTarget(challengeID)
                challengeTarget.should.be.bignumber.equal(this.id)

                const challengeOwner = await this.vouching.challenger(challengeID)
                challengeOwner.should.be.equal(from)

                const challengeAmount = await this.vouching.challengeAmount(challengeID)
                challengeAmount.should.be.bignumber.equal(this.challengeAmount)

                const answerData = await this.vouching.challengeAnswer(challengeID)
                ANSWER[answerData[0].toNumber()].should.be.equal('PENDING')
                answerData[1].should.be.bignumber.equal(0)

                const appealData = await this.vouching.challengeAppeal(challengeID)
                appealData[0].should.equal(ZERO_ADDRESS)
                appealData[1].should.be.bignumber.equal(0)
                appealData[2].should.be.bignumber.equal(0)

                const resolution = await this.vouching.challengeResolution(challengeID)
                RESOLUTION[resolution.toNumber()].should.be.equal('PENDING')
              })

              it('does not update the vouched tokens', async function () {
                const previousVoucherVouched = await this.vouching.vouched(this.id, voucher)
                const previousOwnerVouched = await this.vouching.vouched(this.id, entryOwner)
                const previousTotalVouched = await this.vouching.totalVouched(this.id)

                await this.vouching.challenge(this.id, CHALLENGE_FEE, CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from })

                const voucherVouchedAmount = await this.vouching.vouched(this.id, voucher)
                voucherVouchedAmount.should.be.bignumber.equal(previousVoucherVouched)

                const ownerVouchedAmount = await this.vouching.vouched(this.id, entryOwner)
                ownerVouchedAmount.should.be.bignumber.equal(previousOwnerVouched)

                const totalVouched = await this.vouching.totalVouched(this.id)
                totalVouched.should.be.bignumber.equal(previousTotalVouched)
              })

              it('increases the amount of blocked tokens', async function () {
                const previousVoucherBlocked = await this.vouching.blocked(this.id, voucher)
                const previousVoucherAvailable = await this.vouching.available(this.id, voucher)

                const previousOwnerBlocked = await this.vouching.blocked(this.id, entryOwner)
                const previousOwnerAvailable = await this.vouching.available(this.id, entryOwner)

                const previousTotalBlocked = await this.vouching.totalBlocked(this.id)
                const previousTotalAvailable = await this.vouching.totalAvailable(this.id)

                await this.vouching.challenge(this.id, CHALLENGE_FEE, CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from })

                const voucherBlockedAmount = await this.vouching.blocked(this.id, voucher)
                const voucherChallengedAmount = this.challengeAmount.times(previousVoucherAvailable).div(previousTotalAvailable)
                voucherBlockedAmount.should.be.bignumber.equal(previousVoucherBlocked.plus(voucherChallengedAmount))

                const ownerBlockedAmount = await this.vouching.blocked(this.id, entryOwner)
                const ownerChallengedAmount = this.challengeAmount.times(previousOwnerAvailable).div(previousTotalAvailable)
                ownerBlockedAmount.should.be.bignumber.equal(previousOwnerBlocked.plus(ownerChallengedAmount))

                const totalBlocked = await this.vouching.totalBlocked(this.id)
                totalBlocked.should.be.bignumber.equal(previousTotalBlocked.plus(this.challengeAmount))
              })

              it('decreases the amount of available tokens', async function () {
                const previousVoucherAvailable = await this.vouching.available(this.id, voucher)
                const previousOwnerAvailable = await this.vouching.available(this.id, entryOwner)
                const previousTotalAvailable = await this.vouching.totalAvailable(this.id)

                await this.vouching.challenge(this.id, CHALLENGE_FEE, CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from })

                const voucherAvailableAmount = await this.vouching.available(this.id, voucher)
                const voucherChallengedAmount = this.challengeAmount.times(previousVoucherAvailable).div(previousTotalAvailable)
                voucherAvailableAmount.should.be.bignumber.equal(previousVoucherAvailable.minus(voucherChallengedAmount))

                const ownerAvailableAmount = await this.vouching.available(this.id, entryOwner)
                const ownerChallengedAmount = this.challengeAmount.times(previousOwnerAvailable).div(previousTotalAvailable)
                ownerAvailableAmount.should.be.bignumber.equal(previousOwnerAvailable.minus(ownerChallengedAmount))

                const totalAvailable = await this.vouching.totalAvailable(this.id)
                totalAvailable.should.be.bignumber.equal(previousTotalAvailable.minus(this.challengeAmount))
              })

              it('transfers the challenge amount to the vouching contract', async function () {
                const previousSenderBalance = await this.token.balanceOf(from)
                const previousVouchingBalance = await this.token.balanceOf(this.vouching.address)

                await this.vouching.challenge(this.id, CHALLENGE_FEE, CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from })

                const currentSenderBalance = await this.token.balanceOf(from)
                currentSenderBalance.should.be.bignumber.equal(previousSenderBalance.minus(this.challengeAmount))
                const currentVouchingBalance = await this.token.balanceOf(this.vouching.address)
                currentVouchingBalance.should.be.bignumber.equal(previousVouchingBalance.plus(this.challengeAmount))
              })
            }

            context('when there was no ongoing challenges', function () {
              context('when there was no previous challenge', function () {
                itShouldHandleChallengesProperly()
              })

              context('when there was a previous challenge', function () {
                context('when there was an accepted previous challenge', function () {
                  beforeEach('pay a previous accepted challenge', async function () {
                    const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                    const challengeID = receipt.logs[0].args.challengeID

                    await this.vouching.accept(challengeID, { from: entryOwner })
                    await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                    await this.vouching.confirm(challengeID)
                  })

                  itShouldHandleChallengesProperly()
                })

                context('when there was a rejected previous challenge', function () {
                  beforeEach('charge a previous rejected challenge', async function () {
                    const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                    const challengeID = receipt.logs[0].args.challengeID

                    await this.vouching.reject(challengeID, { from: entryOwner })
                    await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                    await this.vouching.confirm(challengeID)
                  })

                  itShouldHandleChallengesProperly()
                })
              })
            })

            context('when there was an ongoing challenges', function () {
              beforeEach('create challenge', async function () {
                await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
              })

              context('when there was no previous challenge', function () {
                itShouldHandleChallengesProperly()
              })

              context('when there was a previous challenge', function () {
                context('when there was an accepted previous challenge', function () {
                  beforeEach('pay a previous accepted challenge', async function () {
                    const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                    const challengeID = receipt.logs[0].args.challengeID

                    await this.vouching.accept(challengeID, {from: entryOwner})
                    await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                    await this.vouching.confirm(challengeID)
                  })

                  itShouldHandleChallengesProperly()
                })

                context('when there was a rejected previous challenge', function () {
                  beforeEach('charge a previous rejected challenge', async function () {
                    const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                    const challengeID = receipt.logs[0].args.challengeID

                    await this.vouching.reject(challengeID, { from: entryOwner })
                    await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                    await this.vouching.confirm(challengeID)
                  })

                  itShouldHandleChallengesProperly()
                })
              })
            })
          })

          context('when the given fee is not valid', function () {
            const fee = pct(101)

            it('reverts', async function () {
              await assertRevert(this.vouching.challenge(this.id, fee, CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from }))
            })
          })
        })

        context('when the are no tokens vouched for the given entry', function () {
          it('reverts', async function () {
            await assertRevert(this.vouching.challenge(this.id, pct(1), CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from }))
          })
        })
      })

      context('when the sender is the owner of the entry', function () {
        const from = entryOwner

        it('reverts', async function () {
          await assertRevert(this.vouching.challenge(this.id, pct(1), CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from }))
        })
      })
    })

    context('when the entry id does not exist', function () {
      it('reverts', async function () {
        await assertRevert(this.vouching.challenge(1, pct(1), CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from: challenger }))
      })
    })
  })

  describe('accept', function () {
    beforeEach('register an entry and vouch', async function () {
      const receipt = await this.vouching.register(this.entryAddress, MINIMUM_STAKE.times(2), METADATA_URI, METADATA_HASH, { from: entryOwner })
      this.id = receipt.logs[0].args.id
    })

    context('when the challenge id exists', function () {
      const CHALLENGE_FEE = pct(1)
      const CHALLENGE_METADATA_URI = 'challenge uri'
      const CHALLENGE_METADATA_HASH = '0x3a00000000000000000000000000000000000000000000000000000000000001'

      beforeEach('register a challenge', async function () {
        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from: challenger })
        this.challengeID = receipt.logs[0].args.challengeID
        this.challengeAmount = receipt.logs[0].args.amount
      })

      context('when the sender is the owner of the entry', function () {
        const from = entryOwner

        context('when the answer period is still open', function () {
          context('when the challenge was not answered', function () {
            it('stores the answer without changing the rest of the status', async function () {
              const receipt = await this.vouching.accept(this.challengeID, { from })
              const blockTimestamp = web3.eth.getBlock(receipt.receipt.blockNumber).timestamp

              const answerData = await this.vouching.challengeAnswer(this.challengeID)
              ANSWER[answerData[0].toNumber()].should.be.equal('ACCEPTED')
              answerData[1].should.be.bignumber.equal(blockTimestamp)

              const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
              challengeTarget.should.be.bignumber.equal(this.id)

              const challengeOwner = await this.vouching.challenger(this.challengeID)
              challengeOwner.should.be.equal(challenger)

              const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
              challengeAmount.should.be.bignumber.equal(this.challengeAmount)

              const appealData = await this.vouching.challengeAppeal(this.challengeID)
              appealData[0].should.equal(ZERO_ADDRESS)
              appealData[1].should.be.bignumber.equal(0)
              appealData[2].should.be.bignumber.equal(0)

              const resolution = await this.vouching.challengeResolution(this.challengeID)
              RESOLUTION[resolution.toNumber()].should.be.equal('PENDING')
            })

            it('emits an Accepted event', async function () {
              const receipt = await this.vouching.accept(this.challengeID, { from })

              const event = assertEvent.inLogs(receipt.logs, 'Accepted')
              event.args.challengeID.should.be.bignumber.eq(this.challengeID)
            })
          })

          context('when the challenge was answered', function () {
            beforeEach('answer challenge', async function () {
              await this.vouching.accept(this.challengeID, { from: entryOwner })
            })

            context('when the challenge was not appealed nor confirmed', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.accept(this.challengeID, { from }))
              })
            })

            context('when the challenge was confirmed', function () {
              beforeEach('travel after appeal window and confirm challenge', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(this.challengeID)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.accept(this.challengeID, { from }))
              })
            })

            context('when the challenge was appealed', function () {
              beforeEach('appeal challenge', async function () {
                await this.vouching.appeal(this.challengeID, { from: anyone })
              })

              context('when the challenge was not resolved', function () {
                it('reverts', async function () {
                  await assertRevert(this.vouching.accept(this.challengeID, { from }))
                })
              })

              context('when the challenge was overruled', function () {
                beforeEach('overrule challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.accept(this.challengeID, { from }))
                })
              })

              context('when the challenge was sustained', function () {
                beforeEach('sustain challenge', async function () {
                  await this.vouching.sustain(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.accept(this.challengeID, { from }))
                })
              })
            })
          })
        })

        context('when the answer period is closed', function () {
          beforeEach('travel after the answer period', async function () {
            await timeTravel(ANSWER_WINDOW_SECONDS + 1)
          })

          context('when the challenge was not answered', function () {
            it('stores the answer without changing the rest of the status', async function () {
              const receipt = await this.vouching.accept(this.challengeID, { from })
              const blockTimestamp = web3.eth.getBlock(receipt.receipt.blockNumber).timestamp

              const answerData = await this.vouching.challengeAnswer(this.challengeID)
              ANSWER[answerData[0].toNumber()].should.be.equal('ACCEPTED')
              answerData[1].should.be.bignumber.equal(blockTimestamp)

              const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
              challengeTarget.should.be.bignumber.equal(this.id)

              const challengeOwner = await this.vouching.challenger(this.challengeID)
              challengeOwner.should.be.equal(challenger)

              const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
              challengeAmount.should.be.bignumber.equal(this.challengeAmount)

              const appealData = await this.vouching.challengeAppeal(this.challengeID)
              appealData[0].should.equal(ZERO_ADDRESS)
              appealData[1].should.be.bignumber.equal(0)
              appealData[2].should.be.bignumber.equal(0)

              const resolution = await this.vouching.challengeResolution(this.challengeID)
              RESOLUTION[resolution.toNumber()].should.be.equal('PENDING')
            })

            it('emits an Accepted event', async function () {
              const receipt = await this.vouching.accept(this.challengeID, { from })

              const event = assertEvent.inLogs(receipt.logs, 'Accepted')
              event.args.challengeID.should.be.bignumber.eq(this.challengeID)
            })
          })

          context('when the challenge was answered', function () {
            beforeEach('answer challenge', async function () {
              await this.vouching.accept(this.challengeID, { from: entryOwner })
            })

            context('when the challenge was not appealed nor confirmed', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.accept(this.challengeID, { from }))
              })
            })

            context('when the challenge was confirmed', function () {
              beforeEach('travel after appeal window and confirm challenge', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(this.challengeID)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.accept(this.challengeID, { from }))
              })
            })

            context('when the challenge was appealed', function () {
              beforeEach('appeal challenge', async function () {
                await this.vouching.appeal(this.challengeID, { from: anyone })
              })

              context('when the challenge was not resolved', function () {
                it('reverts', async function () {
                  await assertRevert(this.vouching.accept(this.challengeID, { from }))
                })
              })

              context('when the challenge was overruled', function () {
                beforeEach('overrule challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.accept(this.challengeID, { from }))
                })
              })

              context('when the challenge was sustained', function () {
                beforeEach('sustain challenge', async function () {
                  await this.vouching.sustain(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.accept(this.challengeID, { from }))
                })
              })
            })
          })
        })
      })

      context('when the sender is not the owner of the entry', function () {
        const from = voucher

        context('when the answer period is still open', function () {
          context('when the challenge was not answered', function () {
            it('reverts', async function () {
              await assertRevert(this.vouching.accept(this.challengeID, { from }))
            })
          })

          context('when the challenge was answered', function () {
            beforeEach('answer challenge', async function () {
              await this.vouching.accept(this.challengeID, { from: entryOwner })
            })

            context('when the challenge was not appealed nor confirmed', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.accept(this.challengeID, { from }))
              })
            })

            context('when the challenge was confirmed', function () {
              beforeEach('travel after appeal window and confirm challenge', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(this.challengeID)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.accept(this.challengeID, { from }))
              })
            })

            context('when the challenge was appealed', function () {
              beforeEach('appeal challenge', async function () {
                await this.vouching.appeal(this.challengeID, { from: anyone })
              })

              context('when the challenge was not resolved', function () {
                it('reverts', async function () {
                  await assertRevert(this.vouching.accept(this.challengeID, { from }))
                })
              })

              context('when the challenge was overruled', function () {
                beforeEach('overrule challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.accept(this.challengeID, { from }))
                })
              })

              context('when the challenge was sustained', function () {
                beforeEach('sustain challenge', async function () {
                  await this.vouching.sustain(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.accept(this.challengeID, { from }))
                })
              })
            })
          })
        })

        context('when the answer period is closed', function () {
          beforeEach('travel after the answer period', async function () {
            await timeTravel(ANSWER_WINDOW_SECONDS + 1)
          })

          context('when the challenge was not answered', function () {
            it('stores the answer without changing the rest of the status', async function () {
              const receipt = await this.vouching.accept(this.challengeID, { from })
              const blockTimestamp = web3.eth.getBlock(receipt.receipt.blockNumber).timestamp

              const answerData = await this.vouching.challengeAnswer(this.challengeID)
              ANSWER[answerData[0].toNumber()].should.be.equal('ACCEPTED')
              answerData[1].should.be.bignumber.equal(blockTimestamp)

              const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
              challengeTarget.should.be.bignumber.equal(this.id)

              const challengeOwner = await this.vouching.challenger(this.challengeID)
              challengeOwner.should.be.equal(challenger)

              const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
              challengeAmount.should.be.bignumber.equal(this.challengeAmount)

              const appealData = await this.vouching.challengeAppeal(this.challengeID)
              appealData[0].should.equal(ZERO_ADDRESS)
              appealData[1].should.be.bignumber.equal(0)
              appealData[2].should.be.bignumber.equal(0)

              const resolution = await this.vouching.challengeResolution(this.challengeID)
              RESOLUTION[resolution.toNumber()].should.be.equal('PENDING')
            })

            it('emits an Accepted event', async function () {
              const receipt = await this.vouching.accept(this.challengeID, { from })

              const event = assertEvent.inLogs(receipt.logs, 'Accepted')
              event.args.challengeID.should.be.bignumber.eq(this.challengeID)
            })
          })

          context('when the challenge was answered', function () {
            beforeEach('answer challenge', async function () {
              await this.vouching.accept(this.challengeID, { from: entryOwner })
            })

            context('when the challenge was not appealed nor confirmed', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.accept(this.challengeID, { from }))
              })
            })

            context('when the challenge was confirmed', function () {
              beforeEach('travel after appeal window and confirm challenge', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(this.challengeID)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.accept(this.challengeID, { from }))
              })
            })

            context('when the challenge was appealed', function () {
              beforeEach('appeal challenge', async function () {
                await this.vouching.appeal(this.challengeID, { from: anyone })
              })

              context('when the challenge was not resolved', function () {
                it('reverts', async function () {
                  await assertRevert(this.vouching.accept(this.challengeID, { from }))
                })
              })

              context('when the challenge was overruled', function () {
                beforeEach('overrule challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.accept(this.challengeID, { from }))
                })
              })

              context('when the challenge was sustained', function () {
                beforeEach('sustain challenge', async function () {
                  await this.vouching.sustain(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.accept(this.challengeID, { from }))
                })
              })
            })
          })
        })
      })
    })

    context('when the challenge id does not exist', function () {
      it('reverts', async function () {
        await assertRevert(this.vouching.accept(0, { from: entryOwner }))
      })
    })
  })

  describe('reject', function () {
    beforeEach('register an entry and vouch', async function () {
      const receipt = await this.vouching.register(this.entryAddress, MINIMUM_STAKE.times(2), METADATA_URI, METADATA_HASH, { from: entryOwner })
      this.id = receipt.logs[0].args.id
    })

    context('when the challenge id exists', function () {
      const CHALLENGE_FEE = pct(1)
      const CHALLENGE_METADATA_URI = 'challenge uri'
      const CHALLENGE_METADATA_HASH = '0x3a00000000000000000000000000000000000000000000000000000000000001'

      beforeEach('register a challenge', async function () {
        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from: challenger })
        this.challengeID = receipt.logs[0].args.challengeID
        this.challengeAmount = receipt.logs[0].args.amount
      })

      context('when the sender is the owner of the entry', function () {
        const from = entryOwner

        context('when the answer period is still open', function () {
          context('when the challenge was not answered', function () {
            it('stores the answer without changing the rest of the status', async function () {
              const receipt = await this.vouching.reject(this.challengeID, { from })
              const blockTimestamp = web3.eth.getBlock(receipt.receipt.blockNumber).timestamp

              const answerData = await this.vouching.challengeAnswer(this.challengeID)
              ANSWER[answerData[0].toNumber()].should.be.equal('REJECTED')
              answerData[1].should.be.bignumber.equal(blockTimestamp)

              const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
              challengeTarget.should.be.bignumber.equal(this.id)

              const challengeOwner = await this.vouching.challenger(this.challengeID)
              challengeOwner.should.be.equal(challenger)

              const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
              challengeAmount.should.be.bignumber.equal(this.challengeAmount)

              const appealData = await this.vouching.challengeAppeal(this.challengeID)
              appealData[0].should.equal(ZERO_ADDRESS)
              appealData[1].should.be.bignumber.equal(0)
              appealData[2].should.be.bignumber.equal(0)

              const resolution = await this.vouching.challengeResolution(this.challengeID)
              RESOLUTION[resolution.toNumber()].should.be.equal('PENDING')
            })

            it('emits a Rejected event', async function () {
              const receipt = await this.vouching.reject(this.challengeID, { from })

              const event = assertEvent.inLogs(receipt.logs, 'Rejected')
              event.args.challengeID.should.be.bignumber.eq(this.challengeID)
            })
          })

          context('when the challenge was answered', function () {
            beforeEach('answer challenge', async function () {
              await this.vouching.reject(this.challengeID, { from: entryOwner })
            })

            context('when the challenge was not appealed nor confirmed', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.reject(this.challengeID, { from }))
              })
            })

            context('when the challenge was confirmed', function () {
              beforeEach('travel after appeal window and confirm challenge', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(this.challengeID)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.reject(this.challengeID, { from }))
              })
            })

            context('when the challenge was appealed', function () {
              beforeEach('appeal challenge', async function () {
                await this.vouching.appeal(this.challengeID, { from: anyone })
              })

              context('when the challenge was not resolved', function () {
                it('reverts', async function () {
                  await assertRevert(this.vouching.reject(this.challengeID, { from }))
                })
              })

              context('when the challenge was overruled', function () {
                beforeEach('overrule challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.reject(this.challengeID, { from }))
                })
              })

              context('when the challenge was sustained', function () {
                beforeEach('sustain challenge', async function () {
                  await this.vouching.sustain(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.reject(this.challengeID, { from }))
                })
              })
            })
          })
        })

        context('when the answer period is closed', function () {
          beforeEach('travel after the answer period', async function () {
            await timeTravel(ANSWER_WINDOW_SECONDS + 1)
          })

          context('when the challenge was not answered', function () {
            it('stores the answer without changing the rest of the status', async function () {
              const receipt = await this.vouching.reject(this.challengeID, { from })
              const blockTimestamp = web3.eth.getBlock(receipt.receipt.blockNumber).timestamp

              const answerData = await this.vouching.challengeAnswer(this.challengeID)
              ANSWER[answerData[0].toNumber()].should.be.equal('REJECTED')
              answerData[1].should.be.bignumber.equal(blockTimestamp)

              const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
              challengeTarget.should.be.bignumber.equal(this.id)

              const challengeOwner = await this.vouching.challenger(this.challengeID)
              challengeOwner.should.be.equal(challenger)

              const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
              challengeAmount.should.be.bignumber.equal(this.challengeAmount)

              const appealData = await this.vouching.challengeAppeal(this.challengeID)
              appealData[0].should.equal(ZERO_ADDRESS)
              appealData[1].should.be.bignumber.equal(0)
              appealData[2].should.be.bignumber.equal(0)

              const resolution = await this.vouching.challengeResolution(this.challengeID)
              RESOLUTION[resolution.toNumber()].should.be.equal('PENDING')
            })

            it('emits a Rejected event', async function () {
              const receipt = await this.vouching.reject(this.challengeID, { from })

              const event = assertEvent.inLogs(receipt.logs, 'Rejected')
              event.args.challengeID.should.be.bignumber.eq(this.challengeID)
            })
          })

          context('when the challenge was answered', function () {
            beforeEach('answer challenge', async function () {
              await this.vouching.reject(this.challengeID, { from: entryOwner })
            })

            context('when the challenge was not appealed nor confirmed', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.reject(this.challengeID, { from }))
              })
            })

            context('when the challenge was confirmed', function () {
              beforeEach('travel after appeal window and confirm challenge', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(this.challengeID)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.reject(this.challengeID, { from }))
              })
            })

            context('when the challenge was appealed', function () {
              beforeEach('appeal challenge', async function () {
                await this.vouching.appeal(this.challengeID, { from: anyone })
              })

              context('when the challenge was not resolved', function () {
                it('reverts', async function () {
                  await assertRevert(this.vouching.reject(this.challengeID, { from }))
                })
              })

              context('when the challenge was overruled', function () {
                beforeEach('overrule challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.reject(this.challengeID, { from }))
                })
              })

              context('when the challenge was sustained', function () {
                beforeEach('sustain challenge', async function () {
                  await this.vouching.sustain(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.reject(this.challengeID, { from }))
                })
              })
            })
          })
        })
      })

      context('when the sender is not the owner of the entry', function () {
        const from = voucher

        context('when the answer period is still open', function () {
          context('when the challenge was not answered', function () {
            it('reverts', async function () {
              await assertRevert(this.vouching.reject(this.challengeID, { from }))
            })
          })

          context('when the challenge was answered', function () {
            beforeEach('answer challenge', async function () {
              await this.vouching.reject(this.challengeID, { from: entryOwner })
            })

            context('when the challenge was not appealed nor confirmed', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.reject(this.challengeID, { from }))
              })
            })

            context('when the challenge was confirmed', function () {
              beforeEach('travel after appeal window and confirm challenge', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(this.challengeID)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.reject(this.challengeID, { from }))
              })
            })

            context('when the challenge was appealed', function () {
              beforeEach('appeal challenge', async function () {
                await this.vouching.appeal(this.challengeID, { from: anyone })
              })

              context('when the challenge was not resolved', function () {
                it('reverts', async function () {
                  await assertRevert(this.vouching.reject(this.challengeID, { from }))
                })
              })

              context('when the challenge was overruled', function () {
                beforeEach('overrule challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.reject(this.challengeID, { from }))
                })
              })

              context('when the challenge was sustained', function () {
                beforeEach('sustain challenge', async function () {
                  await this.vouching.sustain(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.reject(this.challengeID, { from }))
                })
              })
            })
          })
        })

        context('when the answer period is closed', function () {
          beforeEach('travel after the answer period', async function () {
            await timeTravel(ANSWER_WINDOW_SECONDS + 1)
          })

          context('when the challenge was not answered', function () {
            it('stores the answer without changing the rest of the status', async function () {
              const receipt = await this.vouching.reject(this.challengeID, { from })
              const blockTimestamp = web3.eth.getBlock(receipt.receipt.blockNumber).timestamp

              const answerData = await this.vouching.challengeAnswer(this.challengeID)
              ANSWER[answerData[0].toNumber()].should.be.equal('REJECTED')
              answerData[1].should.be.bignumber.equal(blockTimestamp)

              const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
              challengeTarget.should.be.bignumber.equal(this.id)

              const challengeOwner = await this.vouching.challenger(this.challengeID)
              challengeOwner.should.be.equal(challenger)

              const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
              challengeAmount.should.be.bignumber.equal(this.challengeAmount)

              const appealData = await this.vouching.challengeAppeal(this.challengeID)
              appealData[0].should.equal(ZERO_ADDRESS)
              appealData[1].should.be.bignumber.equal(0)
              appealData[2].should.be.bignumber.equal(0)

              const resolution = await this.vouching.challengeResolution(this.challengeID)
              RESOLUTION[resolution.toNumber()].should.be.equal('PENDING')
            })

            it('emits a Rejected event', async function () {
              const receipt = await this.vouching.reject(this.challengeID, { from })

              const event = assertEvent.inLogs(receipt.logs, 'Rejected')
              event.args.challengeID.should.be.bignumber.eq(this.challengeID)
            })
          })

          context('when the challenge was answered', function () {
            beforeEach('answer challenge', async function () {
              await this.vouching.reject(this.challengeID, { from: entryOwner })
            })

            context('when the challenge was not appealed nor confirmed', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.reject(this.challengeID, { from }))
              })
            })

            context('when the challenge was confirmed', function () {
              beforeEach('travel after appeal window and confirm challenge', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(this.challengeID)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.reject(this.challengeID, { from }))
              })
            })

            context('when the challenge was appealed', function () {
              beforeEach('appeal challenge', async function () {
                await this.vouching.appeal(this.challengeID, { from: anyone })
              })

              context('when the challenge was not resolved', function () {
                it('reverts', async function () {
                  await assertRevert(this.vouching.reject(this.challengeID, { from }))
                })
              })

              context('when the challenge was overruled', function () {
                beforeEach('overrule challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.reject(this.challengeID, { from }))
                })
              })

              context('when the challenge was sustained', function () {
                beforeEach('sustain challenge', async function () {
                  await this.vouching.sustain(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.reject(this.challengeID, { from }))
                })
              })
            })
          })
        })
      })
    })

    context('when the challenge id does not exist', function () {
      it('reverts', async function () {
        await assertRevert(this.vouching.reject(0, { from: entryOwner }))
      })
    })
  })

  describe('confirm', function () {
    const VOUCHER_AMOUNT = zep(5)

    beforeEach('register an entry and vouch', async function () {
      const receipt = await this.vouching.register(this.entryAddress, MINIMUM_STAKE.times(2), METADATA_URI, METADATA_HASH, { from: entryOwner })
      this.id = receipt.logs[0].args.id
      await this.vouching.vouch(this.id, VOUCHER_AMOUNT, { from: voucher })
    })

    context('when the challenge id exists', function () {
      const CHALLENGE_FEE = pct(1)
      const CHALLENGE_METADATA_URI = 'challenge uri'
      const CHALLENGE_METADATA_HASH = '0x3a00000000000000000000000000000000000000000000000000000000000001'

      beforeEach('register a challenge', async function () {
        const previousTotalAvailable = await this.vouching.totalAvailable(this.id)
        const previousOwnerAvailable = await this.vouching.available(this.id, entryOwner)
        const previousVoucherAvailable = await this.vouching.available(this.id, voucher)

        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from: challenger })
        this.challengeID = assertEvent.inLogs(receipt.logs, 'Challenged').args.challengeID
        this.challengeAmount = receipt.logs[0].args.amount
        this.ownerChallengedAmount = this.challengeAmount.times(previousOwnerAvailable).div(previousTotalAvailable)
        this.voucherChallengedAmount = this.challengeAmount.times(previousVoucherAvailable).div(previousTotalAvailable)
      })

      context('when the challenge was answered', function() {
        context('when the challenge was rejected', function () {
          beforeEach('reject the challenge', async function () {
            await this.vouching.reject(this.challengeID, { from: entryOwner })
          })

          context('when the challenge was not appealed nor confirmed', function () {
            context('when the challenge is within the appeal period', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.confirm(this.challengeID))
              })
            })

            context('when the challenge is out of the appeal period', function () {
              beforeEach('travel after the appeal period', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
              })

              const itShouldHandleConfirmsProperly = function () {
                it('emits a Confirmed event', async function () {
                  const receipt = await this.vouching.confirm(this.challengeID)

                  const event = assertEvent.inLogs(receipt.logs, 'Confirmed')
                  event.args.challengeID.should.be.bignumber.eq(this.challengeID)
                })

                it('stores the resolution without changing the rest of the status', async function () {
                  const answeredAt = (await this.vouching.challengeAnswer(this.challengeID))[1]

                  await this.vouching.confirm(this.challengeID)

                  const answerData = await this.vouching.challengeAnswer(this.challengeID)
                  ANSWER[answerData[0].toNumber()].should.be.equal('REJECTED')
                  answerData[1].should.be.bignumber.equal(answeredAt)

                  const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
                  challengeTarget.should.be.bignumber.equal(this.id)

                  const challengeOwner = await this.vouching.challenger(this.challengeID)
                  challengeOwner.should.be.equal(challenger)

                  const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
                  challengeAmount.should.be.bignumber.equal(this.challengeAmount)

                  const appealData = await this.vouching.challengeAppeal(this.challengeID)
                  appealData[0].should.equal(ZERO_ADDRESS)
                  appealData[1].should.be.bignumber.equal(0)
                  appealData[2].should.be.bignumber.equal(0)

                  const resolution = await this.vouching.challengeResolution(this.challengeID)
                  RESOLUTION[resolution.toNumber()].should.be.equal('CONFIRMED')
                })

                it('decreases the amount of blocked tokens', async function () {
                  const previousVoucherBlocked = await this.vouching.blocked(this.id, voucher)
                  const previousOwnerBlocked = await this.vouching.blocked(this.id, entryOwner)
                  const previousTotalBlocked = await this.vouching.totalBlocked(this.id)

                  await this.vouching.confirm(this.challengeID)

                  const voucherBlockedAmount = await this.vouching.blocked(this.id, voucher)
                  voucherBlockedAmount.should.be.bignumber.equal(previousVoucherBlocked.minus(this.voucherChallengedAmount))

                  const ownerBlockedAmount = await this.vouching.blocked(this.id, entryOwner)
                  ownerBlockedAmount.should.be.bignumber.equal(previousOwnerBlocked.minus(this.ownerChallengedAmount))

                  const totalBlocked = await this.vouching.totalBlocked(this.id)
                  totalBlocked.should.be.bignumber.equal(previousTotalBlocked.minus(this.challengeAmount))
                })

                it('increases the amount of available tokens', async function () {
                  const previousVoucherAvailable = await this.vouching.available(this.id, voucher)
                  const previousOwnerAvailable = await this.vouching.available(this.id, entryOwner)
                  const previousTotalAvailable = await this.vouching.totalAvailable(this.id)

                  await this.vouching.confirm(this.challengeID)

                  const voucherAvailableAmount = await this.vouching.available(this.id, voucher)
                  voucherAvailableAmount.should.be.bignumber.equal(previousVoucherAvailable.plus(this.voucherChallengedAmount.times(2)))

                  const ownerAvailableAmount = await this.vouching.available(this.id, entryOwner)
                  ownerAvailableAmount.should.be.bignumber.equal(previousOwnerAvailable.plus(this.ownerChallengedAmount.times(2)))

                  const totalAvailable = await this.vouching.totalAvailable(this.id)
                  totalAvailable.should.be.bignumber.equal(previousTotalAvailable.plus(this.challengeAmount.times(2)))
                })

                it('increases the amount of vouched tokens', async function () {
                  const previousVoucherVouched = await this.vouching.vouched(this.id, voucher)
                  const previousOwnerVouched = await this.vouching.vouched(this.id, entryOwner)
                  const previousTotalVouched = await this.vouching.totalVouched(this.id)

                  await this.vouching.confirm(this.challengeID)

                  const voucherVouchedAmount = await this.vouching.vouched(this.id, voucher)
                  voucherVouchedAmount.should.be.bignumber.equal(previousVoucherVouched.plus(this.voucherChallengedAmount))

                  const ownerVouchedAmount = await this.vouching.vouched(this.id, entryOwner)
                  ownerVouchedAmount.should.be.bignumber.equal(previousOwnerVouched.plus(this.ownerChallengedAmount))

                  const totalVouched = await this.vouching.totalVouched(this.id)
                  totalVouched.should.be.bignumber.equal(previousTotalVouched.plus(this.challengeAmount))
                })

                it('does not transfer the challenged tokens to the challenger', async function () {
                  const previousVouchingBalance = await this.token.balanceOf(this.vouching.address)
                  const previousChallengerBalance = await this.token.balanceOf(challenger)

                  await this.vouching.confirm(this.challengeID)

                  const currentVouchingBalance = await this.token.balanceOf(this.vouching.address)
                  currentVouchingBalance.should.be.bignumber.eq(previousVouchingBalance)

                  const currentChallengerBalance = await this.token.balanceOf(challenger)
                  currentChallengerBalance.should.be.bignumber.eq(previousChallengerBalance)
                })
              }

              context('when there was no ongoing challenges', function () {
                context('when there was no previous challenge', function () {
                  itShouldHandleConfirmsProperly()
                })

                context('when there was a previous challenge', function () {
                  context('when there was an accepted previous challenge', function () {
                    beforeEach('pay a previous accepted challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.accept(challengeID, { from: entryOwner })
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleConfirmsProperly()
                  })

                  context('when there was a rejected previous challenge', function () {
                    beforeEach('charge a previous rejected challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.reject(challengeID, { from: entryOwner })
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleConfirmsProperly()
                  })
                })
              })

              context('when there was an ongoing challenges', function () {
                beforeEach('create challenge', async function () {
                  await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                })

                context('when there was no previous challenge', function () {
                  itShouldHandleConfirmsProperly()
                })

                context('when there was a previous challenge', function () {
                  context('when there was an accepted previous challenge', function () {
                    beforeEach('pay a previous accepted challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.accept(challengeID, {from: entryOwner})
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleConfirmsProperly()
                  })

                  context('when there was a rejected previous challenge', function () {
                    beforeEach('charge a previous rejected challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.reject(challengeID, { from: entryOwner })
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleConfirmsProperly()
                  })
                })
              })
            })
          })

          context('when the challenge was confirmed', function () {
            beforeEach('travel after appeal window and confirm challenge', async function () {
              await timeTravel(APPEAL_WINDOW_SECONDS + 1)
              await this.vouching.confirm(this.challengeID)
            })

            it('reverts', async function () {
              await assertRevert(this.vouching.confirm(this.challengeID))
            })
          })

          context('when the challenge was appealed', function () {
            beforeEach('appeal challenge', async function () {
              await this.vouching.appeal(this.challengeID, { from: anyone })
            })

            context('when the challenge was not resolved', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.confirm(this.challengeID))
              })
            })

            context('when the challenge was overruled', function () {
              beforeEach('overrule challenge', async function () {
                await this.vouching.overrule(this.challengeID, { from: overseer })
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.confirm(this.challengeID))
              })
            })

            context('when the challenge was sustained', function () {
              beforeEach('sustain challenge', async function () {
                await this.vouching.sustain(this.challengeID, { from: overseer })
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.confirm(this.challengeID))
              })
            })
          })
        })

        context('when the challenge was accepted', function () {
          beforeEach('accept the challenge', async function () {
            await this.vouching.accept(this.challengeID, { from: entryOwner })
          })

          context('when the challenge was not appealed nor confirmed', function () {
            context('when the challenge is within the appeal period', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.confirm(this.challengeID))
              })
            })

            context('when the challenge is out of the appeal period', function () {
              beforeEach('travel after the appeal period', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
              })

              const itShouldHandleConfirmsProperly = function () {
                it('emits a Confirmed event', async function () {
                  const receipt = await this.vouching.confirm(this.challengeID)

                  const event = assertEvent.inLogs(receipt.logs, 'Confirmed')
                  event.args.challengeID.should.be.bignumber.eq(this.challengeID)
                })

                it('stores the resolution without changing the rest of the status', async function () {
                  const answeredAt = (await this.vouching.challengeAnswer(this.challengeID))[1]

                  await this.vouching.confirm(this.challengeID)

                  const answerData = await this.vouching.challengeAnswer(this.challengeID)
                  ANSWER[answerData[0].toNumber()].should.be.equal('ACCEPTED')
                  answerData[1].should.be.bignumber.equal(answeredAt)

                  const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
                  challengeTarget.should.be.bignumber.equal(this.id)

                  const challengeOwner = await this.vouching.challenger(this.challengeID)
                  challengeOwner.should.be.equal(challenger)

                  const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
                  challengeAmount.should.be.bignumber.equal(this.challengeAmount)

                  const appealData = await this.vouching.challengeAppeal(this.challengeID)
                  appealData[0].should.equal(ZERO_ADDRESS)
                  appealData[1].should.be.bignumber.equal(0)
                  appealData[2].should.be.bignumber.equal(0)

                  const resolution = await this.vouching.challengeResolution(this.challengeID)
                  RESOLUTION[resolution.toNumber()].should.be.equal('CONFIRMED')
                })

                it('decreases the amount of blocked tokens', async function () {
                  const previousVoucherBlocked = await this.vouching.blocked(this.id, voucher)
                  const previousOwnerBlocked = await this.vouching.blocked(this.id, entryOwner)
                  const previousTotalBlocked = await this.vouching.totalBlocked(this.id)

                  await this.vouching.confirm(this.challengeID)

                  const voucherBlockedAmount = await this.vouching.blocked(this.id, voucher)
                  voucherBlockedAmount.should.be.bignumber.equal(previousVoucherBlocked.minus(this.voucherChallengedAmount))

                  const ownerBlockedAmount = await this.vouching.blocked(this.id, entryOwner)
                  ownerBlockedAmount.should.be.bignumber.equal(previousOwnerBlocked.minus(this.ownerChallengedAmount))

                  const totalBlocked = await this.vouching.totalBlocked(this.id)
                  totalBlocked.should.be.bignumber.equal(previousTotalBlocked.minus(this.challengeAmount))
                })

                it('decreases the amount of vouched tokens', async function () {
                  const previousVoucherVouched = await this.vouching.vouched(this.id, voucher)
                  const previousOwnerVouched = await this.vouching.vouched(this.id, entryOwner)
                  const previousTotalVouched = await this.vouching.totalVouched(this.id)

                  await this.vouching.confirm(this.challengeID)

                  const voucherVouchedAmount = await this.vouching.vouched(this.id, voucher)
                  voucherVouchedAmount.should.be.bignumber.equal(previousVoucherVouched.minus(this.voucherChallengedAmount))

                  const ownerVouchedAmount = await this.vouching.vouched(this.id, entryOwner)
                  ownerVouchedAmount.should.be.bignumber.equal(previousOwnerVouched.minus(this.ownerChallengedAmount))

                  const totalVouched = await this.vouching.totalVouched(this.id)
                  totalVouched.should.be.bignumber.equal(previousTotalVouched.minus(this.challengeAmount))
                })

                it('does not update the amount of available tokens', async function () {
                  const previousVoucherAvailable = await this.vouching.available(this.id, voucher)
                  const previousOwnerAvailable = await this.vouching.available(this.id, entryOwner)
                  const previousTotalAvailable = await this.vouching.totalAvailable(this.id)

                  await this.vouching.confirm(this.challengeID)

                  const voucherAvailableAmount = await this.vouching.available(this.id, voucher)
                  voucherAvailableAmount.should.be.bignumber.equal(previousVoucherAvailable)

                  const ownerAvailableAmount = await this.vouching.available(this.id, entryOwner)
                  ownerAvailableAmount.should.be.bignumber.equal(previousOwnerAvailable)

                  const totalAvailable = await this.vouching.totalAvailable(this.id)
                  totalAvailable.should.be.bignumber.equal(previousTotalAvailable)
                })

                it('transfers the challenged tokens to the challenger', async function () {
                  const previousVouchingBalance = await this.token.balanceOf(this.vouching.address)
                  const previousChallengerBalance = await this.token.balanceOf(challenger)

                  await this.vouching.confirm(this.challengeID)

                  const currentVouchingBalance = await this.token.balanceOf(this.vouching.address)
                  currentVouchingBalance.should.be.bignumber.eq(previousVouchingBalance.minus(this.challengeAmount.times(2)))

                  const currentChallengerBalance = await this.token.balanceOf(challenger)
                  currentChallengerBalance.should.be.bignumber.eq(previousChallengerBalance.plus(this.challengeAmount.times(2)))
                })
              }

              context('when there was no ongoing challenges', function () {
                context('when there was no previous challenge', function () {
                  itShouldHandleConfirmsProperly()
                })

                context('when there was a previous challenge', function () {
                  context('when there was an accepted previous challenge', function () {
                    beforeEach('pay a previous accepted challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.accept(challengeID, { from: entryOwner })
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleConfirmsProperly()
                  })

                  context('when there was a rejected previous challenge', function () {
                    beforeEach('charge a previous rejected challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.reject(challengeID, { from: entryOwner })
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleConfirmsProperly()
                  })
                })
              })

              context('when there was an ongoing challenges', function () {
                beforeEach('create challenge', async function () {
                  await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                })

                context('when there was no previous challenge', function () {
                  itShouldHandleConfirmsProperly()
                })

                context('when there was a previous challenge', function () {
                  context('when there was an accepted previous challenge', function () {
                    beforeEach('pay a previous accepted challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.accept(challengeID, {from: entryOwner})
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleConfirmsProperly()
                  })

                  context('when there was a rejected previous challenge', function () {
                    beforeEach('charge a previous rejected challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.reject(challengeID, { from: entryOwner })
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleConfirmsProperly()
                  })
                })
              })
            })
          })

          context('when the challenge was confirmed', function () {
            beforeEach('travel after appeal window and confirm challenge', async function () {
              await timeTravel(APPEAL_WINDOW_SECONDS + 1)
              await this.vouching.confirm(this.challengeID)
            })

            it('reverts', async function () {
              await assertRevert(this.vouching.confirm(this.challengeID))
            })
          })

          context('when the challenge was appealed', function () {
            beforeEach('appeal challenge', async function () {
              await this.vouching.appeal(this.challengeID, { from: anyone })
            })

            context('when the challenge was not resolved', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.confirm(this.challengeID))
              })
            })

            context('when the challenge was overruled', function () {
              beforeEach('overrule challenge', async function () {
                await this.vouching.overrule(this.challengeID, { from: overseer })
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.confirm(this.challengeID))
              })
            })

            context('when the challenge was sustained', function () {
              beforeEach('sustain challenge', async function () {
                await this.vouching.sustain(this.challengeID, { from: overseer })
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.confirm(this.challengeID))
              })
            })
          })
        })
      })

      context('when the challenge was not answered', function() {
        context('when the answer period is still open', function () {
          it('reverts', async function () {
            await assertRevert(this.vouching.confirm(this.challengeID))
          })
        })

        context('when the answer period is closed', function () {
          beforeEach('travel after the answer period', async function () {
            await timeTravel(ANSWER_WINDOW_SECONDS + 1)
          })

          it('reverts', async function () {
            await assertRevert(this.vouching.confirm(this.challengeID))
          })
        })
      })
    })

    context('when the challenge id does not exist', function () {
      it('reverts', async function () {
        await assertRevert(this.vouching.confirm(0))
      })
    })
  })

  describe('appeal', function () {
    const appealer = anyone
    const VOUCHER_AMOUNT = zep(5)

    beforeEach('register an entry and vouch', async function () {
      const receipt = await this.vouching.register(this.entryAddress, MINIMUM_STAKE.times(2), METADATA_URI, METADATA_HASH, { from: entryOwner })
      this.id = receipt.logs[0].args.id
      await this.vouching.vouch(this.id, VOUCHER_AMOUNT, { from: voucher })
    })

    context('when the challenge id exists', function () {
      const CHALLENGE_FEE = pct(1)
      const CHALLENGE_METADATA_URI = 'challenge uri'
      const CHALLENGE_METADATA_HASH = '0x3a00000000000000000000000000000000000000000000000000000000000001'

      const registerChallenge = function () {
        beforeEach('register a challenge', async function () {
          const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from: challenger })
          this.challengeID = receipt.logs[0].args.challengeID
          this.challengeAmount = receipt.logs[0].args.amount
          this.appealAmount = this.challengeAmount.mul(APPEAL_FEE).div(PCT_BASE)
        })
      }

      context('when the challenge was answered', function() {
        context('when the challenge was rejected', function () {
          const registerRejectedChallenge = function () {
            registerChallenge()

            beforeEach('reject the challenge', async function () {
              await this.vouching.reject(this.challengeID, { from: entryOwner })
            })
          }

          context('when the challenge was not appealed nor confirmed', function () {
            context('when the challenge is within the appeal period', function () {
              const itShouldHandleAppealsProperly = function () {
                registerRejectedChallenge()

                it('emits an Appealed event', async function () {
                  const receipt = await this.vouching.appeal(this.challengeID, { from: appealer })

                  const event = assertEvent.inLogs(receipt.logs, 'Appealed')
                  event.args.challengeID.should.be.bignumber.eq(this.challengeID)
                  event.args.appealer.should.be.bignumber.eq(anyone)
                  event.args.amount.should.be.bignumber.eq(this.appealAmount)
                })

                it('stores the appeal without changing the rest of the status', async function () {
                  const answeredAt = (await this.vouching.challengeAnswer(this.challengeID))[1]

                  const receipt = await this.vouching.appeal(this.challengeID, { from: appealer })
                  const blockTimestamp = web3.eth.getBlock(receipt.receipt.blockNumber).timestamp

                  const answerData = await this.vouching.challengeAnswer(this.challengeID)
                  ANSWER[answerData[0].toNumber()].should.be.equal('REJECTED')
                  answerData[1].should.be.bignumber.equal(answeredAt)

                  const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
                  challengeTarget.should.be.bignumber.equal(this.id)

                  const challengeOwner = await this.vouching.challenger(this.challengeID)
                  challengeOwner.should.be.equal(challenger)

                  const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
                  challengeAmount.should.be.bignumber.equal(this.challengeAmount)

                  const appealData = await this.vouching.challengeAppeal(this.challengeID)
                  appealData[0].should.equal(appealer)
                  appealData[1].should.be.bignumber.equal(this.appealAmount)
                  appealData[2].should.be.bignumber.equal(blockTimestamp)

                  const resolution = await this.vouching.challengeResolution(this.challengeID)
                  RESOLUTION[resolution.toNumber()].should.be.equal('PENDING')
                })

                it('does not update the amount of blocked tokens', async function () {
                  const previousVoucherBlocked = await this.vouching.blocked(this.id, voucher)
                  const previousOwnerBlocked = await this.vouching.blocked(this.id, entryOwner)
                  const previousTotalBlocked = await this.vouching.totalBlocked(this.id)

                  await this.vouching.appeal(this.challengeID, { from: appealer })

                  const voucherBlockedAmount = await this.vouching.blocked(this.id, voucher)
                  voucherBlockedAmount.should.be.bignumber.equal(previousVoucherBlocked)

                  const ownerBlockedAmount = await this.vouching.blocked(this.id, entryOwner)
                  ownerBlockedAmount.should.be.bignumber.equal(previousOwnerBlocked)

                  const totalBlocked = await this.vouching.totalBlocked(this.id)
                  totalBlocked.should.be.bignumber.equal(previousTotalBlocked)
                })

                it('does not update the amount of available tokens', async function () {
                  const previousVoucherAvailable = await this.vouching.available(this.id, voucher)
                  const previousOwnerAvailable = await this.vouching.available(this.id, entryOwner)
                  const previousTotalAvailable = await this.vouching.totalAvailable(this.id)

                  await this.vouching.appeal(this.challengeID, { from: appealer })

                  const voucherAvailableAmount = await this.vouching.available(this.id, voucher)
                  voucherAvailableAmount.should.be.bignumber.equal(previousVoucherAvailable)

                  const ownerAvailableAmount = await this.vouching.available(this.id, entryOwner)
                  ownerAvailableAmount.should.be.bignumber.equal(previousOwnerAvailable)

                  const totalAvailable = await this.vouching.totalAvailable(this.id)
                  totalAvailable.should.be.bignumber.equal(previousTotalAvailable)
                })

                it('does not update the amount of vouched tokens', async function () {
                  const previousVoucherVouched = await this.vouching.vouched(this.id, voucher)
                  const previousOwnerVouched = await this.vouching.vouched(this.id, entryOwner)
                  const previousTotalVouched = await this.vouching.totalVouched(this.id)

                  await this.vouching.appeal(this.challengeID, { from: appealer })

                  const voucherVouchedAmount = await this.vouching.vouched(this.id, voucher)
                  voucherVouchedAmount.should.be.bignumber.equal(previousVoucherVouched)

                  const ownerVouchedAmount = await this.vouching.vouched(this.id, entryOwner)
                  ownerVouchedAmount.should.be.bignumber.equal(previousOwnerVouched)

                  const totalVouched = await this.vouching.totalVouched(this.id)
                  totalVouched.should.be.bignumber.equal(previousTotalVouched)
                })

                it('transfers the appealed tokens to the vouching contract', async function () {
                  const previousAppealerBalance = await this.token.balanceOf(appealer)
                  const previousVouchingBalance = await this.token.balanceOf(this.vouching.address)

                  await this.vouching.appeal(this.challengeID, { from: appealer })

                  const currentAppealerBalance = await this.token.balanceOf(appealer)
                  currentAppealerBalance.should.be.bignumber.eq(previousAppealerBalance.minus(this.appealAmount))

                  const currentVouchingBalance = await this.token.balanceOf(this.vouching.address)
                  currentVouchingBalance.should.be.bignumber.eq(previousVouchingBalance.plus(this.appealAmount))
                })
              }

              context('when there was no ongoing challenges', function () {
                context('when there was no previous challenge', function () {
                  itShouldHandleAppealsProperly()
                })

                context('when there was a previous challenge', function () {
                  context('when there was an accepted previous challenge', function () {
                    beforeEach('pay a previous accepted challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.accept(challengeID, { from: entryOwner })
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleAppealsProperly()
                  })

                  context('when there was a rejected previous challenge', function () {
                    beforeEach('charge a previous rejected challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.reject(challengeID, { from: entryOwner })
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleAppealsProperly()
                  })
                })
              })

              context('when there was an ongoing challenges', function () {
                beforeEach('create challenge', async function () {
                  await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                })

                context('when there was no previous challenge', function () {
                  itShouldHandleAppealsProperly()
                })

                context('when there was a previous challenge', function () {
                  context('when there was an accepted previous challenge', function () {
                    beforeEach('pay a previous accepted challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.accept(challengeID, { from: entryOwner })
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleAppealsProperly()
                  })

                  context('when there was a rejected previous challenge', function () {
                    beforeEach('charge a previous rejected challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.reject(challengeID, { from: entryOwner })
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleAppealsProperly()
                  })
                })
              })
            })

            context('when the challenge is out of the appeal period', function () {
              registerRejectedChallenge()

              beforeEach('travel after the appeal period', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.appeal(this.challengeID, { from: appealer }))
              })
            })
          })

          context('when the challenge was confirmed', function () {
            registerRejectedChallenge()

            beforeEach('travel after appeal window and confirm challenge', async function () {
              await timeTravel(APPEAL_WINDOW_SECONDS + 1)
              await this.vouching.confirm(this.challengeID)
            })

            it('reverts', async function () {
              await assertRevert(this.vouching.appeal(this.challengeID, { from: appealer }))
            })
          })

          context('when the challenge was appealed', function () {
            registerRejectedChallenge()

            beforeEach('appeal challenge', async function () {
              await this.vouching.appeal(this.challengeID, { from: appealer })
            })

            context('when the challenge was not resolved', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.appeal(this.challengeID, { from: appealer }))
              })
            })

            context('when the challenge was overruled', function () {
              beforeEach('overrule challenge', async function () {
                await this.vouching.overrule(this.challengeID, { from: overseer })
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.appeal(this.challengeID, { from: appealer }))
              })
            })

            context('when the challenge was sustained', function () {
              beforeEach('sustain challenge', async function () {
                await this.vouching.sustain(this.challengeID, { from: overseer })
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.appeal(this.challengeID, { from: appealer }))
              })
            })
          })
        })

        context('when the challenge was accepted', function () {
          const registerAcceptedChallenge = function () {
            registerChallenge()

            beforeEach('accept the challenge', async function () {
              await this.vouching.accept(this.challengeID, { from: entryOwner })
            })
          }

          context('when the challenge was not appealed nor confirmed', function () {
            context('when the challenge is within the appeal period', function () {
              const itShouldHandleAppealsProperly = function () {
                registerAcceptedChallenge()

                it('emits an Appealed event', async function () {
                  const receipt = await this.vouching.appeal(this.challengeID, { from: appealer })

                  const event = assertEvent.inLogs(receipt.logs, 'Appealed')
                  event.args.challengeID.should.be.bignumber.eq(this.challengeID)
                  event.args.appealer.should.be.bignumber.eq(anyone)
                  event.args.amount.should.be.bignumber.eq(this.appealAmount)
                })

                it('stores the appeal without changing the rest of the status', async function () {
                  const answeredAt = (await this.vouching.challengeAnswer(this.challengeID))[1]

                  const receipt = await this.vouching.appeal(this.challengeID, { from: appealer })
                  const blockTimestamp = web3.eth.getBlock(receipt.receipt.blockNumber).timestamp

                  const answerData = await this.vouching.challengeAnswer(this.challengeID)
                  ANSWER[answerData[0].toNumber()].should.be.equal('ACCEPTED')
                  answerData[1].should.be.bignumber.equal(answeredAt)

                  const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
                  challengeTarget.should.be.bignumber.equal(this.id)

                  const challengeOwner = await this.vouching.challenger(this.challengeID)
                  challengeOwner.should.be.equal(challenger)

                  const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
                  challengeAmount.should.be.bignumber.equal(this.challengeAmount)

                  const appealData = await this.vouching.challengeAppeal(this.challengeID)
                  appealData[0].should.equal(appealer)
                  appealData[1].should.be.bignumber.equal(this.appealAmount)
                  appealData[2].should.be.bignumber.equal(blockTimestamp)

                  const resolution = await this.vouching.challengeResolution(this.challengeID)
                  RESOLUTION[resolution.toNumber()].should.be.equal('PENDING')
                })

                it('does not update the amount of blocked tokens', async function () {
                  const previousVoucherBlocked = await this.vouching.blocked(this.id, voucher)
                  const previousOwnerBlocked = await this.vouching.blocked(this.id, entryOwner)
                  const previousTotalBlocked = await this.vouching.totalBlocked(this.id)

                  await this.vouching.appeal(this.challengeID, { from: appealer })

                  const voucherBlockedAmount = await this.vouching.blocked(this.id, voucher)
                  voucherBlockedAmount.should.be.bignumber.equal(previousVoucherBlocked)

                  const ownerBlockedAmount = await this.vouching.blocked(this.id, entryOwner)
                  ownerBlockedAmount.should.be.bignumber.equal(previousOwnerBlocked)

                  const totalBlocked = await this.vouching.totalBlocked(this.id)
                  totalBlocked.should.be.bignumber.equal(previousTotalBlocked)
                })

                it('does not update the amount of available tokens', async function () {
                  const previousVoucherAvailable = await this.vouching.available(this.id, voucher)
                  const previousOwnerAvailable = await this.vouching.available(this.id, entryOwner)
                  const previousTotalAvailable = await this.vouching.totalAvailable(this.id)

                  await this.vouching.appeal(this.challengeID, { from: appealer })

                  const voucherAvailableAmount = await this.vouching.available(this.id, voucher)
                  voucherAvailableAmount.should.be.bignumber.equal(previousVoucherAvailable)

                  const ownerAvailableAmount = await this.vouching.available(this.id, entryOwner)
                  ownerAvailableAmount.should.be.bignumber.equal(previousOwnerAvailable)

                  const totalAvailable = await this.vouching.totalAvailable(this.id)
                  totalAvailable.should.be.bignumber.equal(previousTotalAvailable)
                })

                it('does not update the amount of vouched tokens', async function () {
                  const previousVoucherVouched = await this.vouching.vouched(this.id, voucher)
                  const previousOwnerVouched = await this.vouching.vouched(this.id, entryOwner)
                  const previousTotalVouched = await this.vouching.totalVouched(this.id)

                  await this.vouching.appeal(this.challengeID, { from: appealer })

                  const voucherVouchedAmount = await this.vouching.vouched(this.id, voucher)
                  voucherVouchedAmount.should.be.bignumber.equal(previousVoucherVouched)

                  const ownerVouchedAmount = await this.vouching.vouched(this.id, entryOwner)
                  ownerVouchedAmount.should.be.bignumber.equal(previousOwnerVouched)

                  const totalVouched = await this.vouching.totalVouched(this.id)
                  totalVouched.should.be.bignumber.equal(previousTotalVouched)
                })

                it('transfers the appealed tokens to the vouching contract', async function () {
                  const previousAppealerBalance = await this.token.balanceOf(appealer)
                  const previousVouchingBalance = await this.token.balanceOf(this.vouching.address)

                  await this.vouching.appeal(this.challengeID, { from: appealer })

                  const currentAppealerBalance = await this.token.balanceOf(appealer)
                  currentAppealerBalance.should.be.bignumber.eq(previousAppealerBalance.minus(this.appealAmount))

                  const currentVouchingBalance = await this.token.balanceOf(this.vouching.address)
                  currentVouchingBalance.should.be.bignumber.eq(previousVouchingBalance.plus(this.appealAmount))
                })
              }

              context('when there was no ongoing challenges', function () {
                context('when there was no previous challenge', function () {
                  itShouldHandleAppealsProperly()
                })

                context('when there was a previous challenge', function () {
                  context('when there was an accepted previous challenge', function () {
                    beforeEach('pay a previous accepted challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.accept(challengeID, { from: entryOwner })
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleAppealsProperly()
                  })

                  context('when there was a rejected previous challenge', function () {
                    beforeEach('charge a previous rejected challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.reject(challengeID, { from: entryOwner })
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleAppealsProperly()
                  })
                })
              })

              context('when there was an ongoing challenges', function () {
                beforeEach('create challenge', async function () {
                  await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                })

                context('when there was no previous challenge', function () {
                  itShouldHandleAppealsProperly()
                })

                context('when there was a previous challenge', function () {
                  context('when there was an accepted previous challenge', function () {
                    beforeEach('pay a previous accepted challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.accept(challengeID, {from: entryOwner})
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleAppealsProperly()
                  })

                  context('when there was a rejected previous challenge', function () {
                    beforeEach('charge a previous rejected challenge', async function () {
                      const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                      const challengeID = receipt.logs[0].args.challengeID

                      await this.vouching.reject(challengeID, { from: entryOwner })
                      await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                      await this.vouching.confirm(challengeID)
                    })

                    itShouldHandleAppealsProperly()
                  })
                })
              })
            })

            context('when the challenge is out of the appeal period', function () {
              registerAcceptedChallenge()

              beforeEach('travel after the appeal period', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.appeal(this.challengeID, { from: appealer }))
              })
            })
          })

          context('when the challenge was confirmed', function () {
            registerAcceptedChallenge()

            beforeEach('travel after appeal window and confirm challenge', async function () {
              await timeTravel(APPEAL_WINDOW_SECONDS + 1)
              await this.vouching.confirm(this.challengeID)
            })

            it('reverts', async function () {
              await assertRevert(this.vouching.appeal(this.challengeID, { from: appealer }))
            })
          })

          context('when the challenge was appealed', function () {
            registerAcceptedChallenge()

            beforeEach('appeal challenge', async function () {
              await this.vouching.appeal(this.challengeID, { from: anyone })
            })

            context('when the challenge was not resolved', function () {
              it('reverts', async function () {
                await assertRevert(this.vouching.appeal(this.challengeID, { from: appealer }))
              })
            })

            context('when the challenge was overruled', function () {
              beforeEach('overrule challenge', async function () {
                await this.vouching.overrule(this.challengeID, { from: overseer })
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.appeal(this.challengeID, { from: appealer }))
              })
            })

            context('when the challenge was sustained', function () {
              beforeEach('sustain challenge', async function () {
                await this.vouching.sustain(this.challengeID, { from: overseer })
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.appeal(this.challengeID, { from: appealer }))
              })
            })
          })
        })
      })

      context('when the challenge was not answered', function() {
        registerChallenge()

        context('when the answer period is still open', function () {
          it('reverts', async function () {
            await assertRevert(this.vouching.appeal(this.challengeID, { from: appealer }))
          })
        })

        context('when the answer period is closed', function () {
          beforeEach('travel after the answer period', async function () {
            await timeTravel(ANSWER_WINDOW_SECONDS + 1)
          })

          it('reverts', async function () {
            await assertRevert(this.vouching.appeal(this.challengeID, { from: appealer }))
          })
        })
      })
    })

    context('when the challenge id does not exist', function () {
      it('reverts', async function () {
        await assertRevert(this.vouching.appeal(0, { from: appealer }))
      })
    })
  })

  describe('sustain', function () {
    const VOUCHER_AMOUNT = zep(5)

    beforeEach('register an entry and vouch', async function () {
      const receipt = await this.vouching.register(this.entryAddress, MINIMUM_STAKE.times(2), METADATA_URI, METADATA_HASH, { from: entryOwner })
      this.id = receipt.logs[0].args.id
      await this.vouching.vouch(this.id, VOUCHER_AMOUNT, { from: voucher })
    })

    context('when the challenge id exists', function () {
      const CHALLENGE_FEE = pct(1)
      const CHALLENGE_METADATA_URI = 'challenge uri'
      const CHALLENGE_METADATA_HASH = '0x3a00000000000000000000000000000000000000000000000000000000000001'

      const registerChallenge = function () {
        beforeEach('register a challenge', async function () {
          const previousTotalAvailable = await this.vouching.totalAvailable(this.id)
          const previousOwnerAvailable = await this.vouching.available(this.id, entryOwner)
          const previousVoucherAvailable = await this.vouching.available(this.id, voucher)

          const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, { from: challenger })
          this.challengeID = receipt.logs[0].args.challengeID
          this.challengeAmount = receipt.logs[0].args.amount
          this.appealAmount = this.challengeAmount.mul(APPEAL_FEE).div(PCT_BASE)
          this.ownerAppealedAmount = this.appealAmount.times(previousOwnerAvailable).div(previousTotalAvailable)
          this.ownerChallengedAmount = this.challengeAmount.times(previousOwnerAvailable).div(previousTotalAvailable)
          this.voucherAppealedAmount = this.appealAmount.times(previousVoucherAvailable).div(previousTotalAvailable)
          this.voucherChallengedAmount = this.challengeAmount.times(previousVoucherAvailable).div(previousTotalAvailable)
        })
      }

      context('when the sender is the overseer', function () {
        const from = overseer

        context('when the challenge was answered', function() {
          context('when the challenge was rejected', function () {
            const registerRejectedChallenge = function () {
              registerChallenge()

              beforeEach('reject the challenge', async function () {
                await this.vouching.reject(this.challengeID, { from: entryOwner })
              })
            }

            context('when the challenge was not appealed nor confirmed', function () {
              registerRejectedChallenge()

              context('when the challenge is within the appeal period', function () {
                it('reverts', async function () {
                  await assertRevert(this.vouching.sustain(this.challengeID, { from }))
                })
              })

              context('when the challenge is out of the appeal period', function () {
                beforeEach('travel after the appeal period', async function () {
                  await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.sustain(this.challengeID, { from }))
                })
              })
            })

            context('when the challenge was confirmed', function () {
              registerRejectedChallenge()

              beforeEach('travel after appeal window and confirm challenge', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(this.challengeID)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.sustain(this.challengeID, { from }))
              })
            })

            context('when the challenge was appealed', function () {
              const appealer = anyone

              const registerAppealedRejectedChallenge = function () {
                registerRejectedChallenge()

                beforeEach('appeal challenge', async function () {
                  await this.vouching.appeal(this.challengeID, { from: appealer })
                })
              }

              context('when the challenge was not resolved', function () {
                const itShouldHandleSustainsProperly = function () {
                  registerAppealedRejectedChallenge()

                  it('emits a Sustained event', async function () {
                    const receipt = await this.vouching.sustain(this.challengeID, { from })

                    const event = assertEvent.inLogs(receipt.logs, 'Sustained')
                    event.args.challengeID.should.be.bignumber.eq(this.challengeID)
                    event.args.overseer.should.be.bignumber.eq(from)
                  })

                  it('stores the resolution without changing the rest of the status', async function () {
                    const answeredAt = (await this.vouching.challengeAnswer(this.challengeID))[1]
                    const appealedAt = (await this.vouching.challengeAppeal(this.challengeID))[2]

                    await this.vouching.sustain(this.challengeID, { from })

                    const answerData = await this.vouching.challengeAnswer(this.challengeID)
                    ANSWER[answerData[0].toNumber()].should.be.equal('REJECTED')
                    answerData[1].should.be.bignumber.equal(answeredAt)

                    const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
                    challengeTarget.should.be.bignumber.equal(this.id)

                    const challengeOwner = await this.vouching.challenger(this.challengeID)
                    challengeOwner.should.be.equal(challenger)

                    const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
                    challengeAmount.should.be.bignumber.equal(this.challengeAmount)

                    const appealData = await this.vouching.challengeAppeal(this.challengeID)
                    appealData[0].should.equal(appealer)
                    appealData[1].should.be.bignumber.equal(this.appealAmount)
                    appealData[2].should.be.bignumber.equal(appealedAt)

                    const resolution = await this.vouching.challengeResolution(this.challengeID)
                    RESOLUTION[resolution.toNumber()].should.be.equal('SUSTAINED')
                  })

                  it('decreases the amount of blocked tokens', async function () {
                    const previousVoucherBlocked = await this.vouching.blocked(this.id, voucher)
                    const previousOwnerBlocked = await this.vouching.blocked(this.id, entryOwner)
                    const previousTotalBlocked = await this.vouching.totalBlocked(this.id)

                    await this.vouching.sustain(this.challengeID, { from })

                    const voucherBlockedAmount = await this.vouching.blocked(this.id, voucher)
                    voucherBlockedAmount.should.be.bignumber.equal(previousVoucherBlocked.minus(this.voucherChallengedAmount))

                    const ownerBlockedAmount = await this.vouching.blocked(this.id, entryOwner)
                    ownerBlockedAmount.should.be.bignumber.equal(previousOwnerBlocked.minus(this.ownerChallengedAmount))

                    const totalBlocked = await this.vouching.totalBlocked(this.id)
                    totalBlocked.should.be.bignumber.equal(previousTotalBlocked.minus(this.challengeAmount))
                  })

                  it('decreases the amount of vouched tokens', async function () {
                    const previousVoucherVouched = await this.vouching.vouched(this.id, voucher)
                    const previousOwnerVouched = await this.vouching.vouched(this.id, entryOwner)
                    const previousTotalVouched = await this.vouching.totalVouched(this.id)

                    await this.vouching.sustain(this.challengeID, { from })

                    const voucherVouchedAmount = await this.vouching.vouched(this.id, voucher)
                    voucherVouchedAmount.should.be.bignumber.equal(previousVoucherVouched.minus(this.voucherChallengedAmount))

                    const ownerVouchedAmount = await this.vouching.vouched(this.id, entryOwner)
                    ownerVouchedAmount.should.be.bignumber.equal(previousOwnerVouched.minus(this.ownerChallengedAmount))

                    const totalVouched = await this.vouching.totalVouched(this.id)
                    totalVouched.should.be.bignumber.equal(previousTotalVouched.minus(this.challengeAmount))
                  })

                  it('does not update the amount of available tokens', async function () {
                    const previousVoucherAvailable = await this.vouching.available(this.id, voucher)
                    const previousOwnerAvailable = await this.vouching.available(this.id, entryOwner)
                    const previousTotalAvailable = await this.vouching.totalAvailable(this.id)

                    await this.vouching.sustain(this.challengeID, { from })

                    const voucherAvailableAmount = await this.vouching.available(this.id, voucher)
                    voucherAvailableAmount.should.be.bignumber.equal(previousVoucherAvailable)

                    const ownerAvailableAmount = await this.vouching.available(this.id, entryOwner)
                    ownerAvailableAmount.should.be.bignumber.equal(previousOwnerAvailable)

                    const totalAvailable = await this.vouching.totalAvailable(this.id)
                    totalAvailable.should.be.bignumber.equal(previousTotalAvailable)
                  })

                  it('transfers the respective payout tokens to the appealer and the challenger', async function () {
                    const previousAppealerBalance = await this.token.balanceOf(appealer)
                    const previousChallengerBalance = await this.token.balanceOf(challenger)
                    const previousVouchingBalance = await this.token.balanceOf(this.vouching.address)

                    await this.vouching.sustain(this.challengeID, { from })

                    const currentAppealerBalance = await this.token.balanceOf(appealer)
                    currentAppealerBalance.should.be.bignumber.eq(previousAppealerBalance.plus(this.appealAmount.times(2)))

                    const currentChallengerBalance = await this.token.balanceOf(challenger)
                    currentChallengerBalance.should.be.bignumber.eq(previousChallengerBalance.plus(this.challengeAmount.times(2).minus(this.appealAmount)))

                    const currentVouchingBalance = await this.token.balanceOf(this.vouching.address)
                    currentVouchingBalance.should.be.bignumber.eq(previousVouchingBalance.minus(this.challengeAmount.times(2)).minus(this.appealAmount))
                  })
                }

                context('when there was no ongoing challenges', function () {
                  context('when there was no previous challenge', function () {
                    itShouldHandleSustainsProperly()
                  })

                  context('when there was a previous challenge', function () {
                    context('when there was an accepted previous challenge', function () {
                      beforeEach('pay a previous accepted challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.accept(challengeID, { from: entryOwner })
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleSustainsProperly()
                    })

                    context('when there was a rejected previous challenge', function () {
                      beforeEach('charge a previous rejected challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.reject(challengeID, { from: entryOwner })
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleSustainsProperly()
                    })
                  })
                })

                context('when there was an ongoing challenges', function () {
                  beforeEach('create challenge', async function () {
                    await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                  })

                  context('when there was no previous challenge', function () {
                    itShouldHandleSustainsProperly()
                  })

                  context('when there was a previous challenge', function () {
                    context('when there was an accepted previous challenge', function () {
                      beforeEach('pay a previous accepted challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.accept(challengeID, {from: entryOwner})
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleSustainsProperly()
                    })

                    context('when there was a rejected previous challenge', function () {
                      beforeEach('charge a previous rejected challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.reject(challengeID, { from: entryOwner })
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleSustainsProperly()
                    })
                  })
                })
              })

              context('when the challenge was overruled', function () {
                registerAppealedRejectedChallenge()

                beforeEach('overrule challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.sustain(this.challengeID, { from }))
                })
              })

              context('when the challenge was sustained', function () {
                registerAppealedRejectedChallenge()

                beforeEach('sustain challenge', async function () {
                  await this.vouching.sustain(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.sustain(this.challengeID, { from }))
                })
              })
            })
          })

          context('when the challenge was accepted', function () {
            const registerAcceptedChallenge = function () {
              registerChallenge()

              beforeEach('accept the challenge', async function () {
                await this.vouching.accept(this.challengeID, { from: entryOwner })
              })
            }

            context('when the challenge was not appealed nor confirmed', function () {
              registerAcceptedChallenge()

              context('when the challenge is within the appeal period', function () {
                it('reverts', async function () {
                  await assertRevert(this.vouching.sustain(this.challengeID, { from }))
                })
              })

              context('when the challenge is out of the appeal period', function () {
                beforeEach('travel after the appeal period', async function () {
                  await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.sustain(this.challengeID, { from }))
                })
              })
            })

            context('when the challenge was confirmed', function () {
              registerAcceptedChallenge()

              beforeEach('travel after appeal window and confirm challenge', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(this.challengeID)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.sustain(this.challengeID, { from }))
              })
            })

            context('when the challenge was appealed', function () {
              const appealer = anyone

              const registerAppealedAcceptedChallenge = function () {
                registerAcceptedChallenge()

                beforeEach('appeal challenge', async function () {
                await this.vouching.appeal(this.challengeID, { from: appealer })
              })
              }

              context('when the challenge was not resolved', function () {
                const itShouldHandleSustainsProperly = function () {
                  registerAppealedAcceptedChallenge()

                  it('emits a Sustained event', async function () {
                    const receipt = await this.vouching.sustain(this.challengeID, { from })

                    const event = assertEvent.inLogs(receipt.logs, 'Sustained')
                    event.args.challengeID.should.be.bignumber.eq(this.challengeID)
                    event.args.overseer.should.be.bignumber.eq(from)
                  })

                  it('stores the resolution without changing the rest of the status', async function () {
                    const answeredAt = (await this.vouching.challengeAnswer(this.challengeID))[1]
                    const appealedAt = (await this.vouching.challengeAppeal(this.challengeID))[2]

                    await this.vouching.sustain(this.challengeID, { from })

                    const answerData = await this.vouching.challengeAnswer(this.challengeID)
                    ANSWER[answerData[0].toNumber()].should.be.equal('ACCEPTED')
                    answerData[1].should.be.bignumber.equal(answeredAt)

                    const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
                    challengeTarget.should.be.bignumber.equal(this.id)

                    const challengeOwner = await this.vouching.challenger(this.challengeID)
                    challengeOwner.should.be.equal(challenger)

                    const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
                    challengeAmount.should.be.bignumber.equal(this.challengeAmount)

                    const appealData = await this.vouching.challengeAppeal(this.challengeID)
                    appealData[0].should.equal(appealer)
                    appealData[1].should.be.bignumber.equal(this.appealAmount)
                    appealData[2].should.be.bignumber.equal(appealedAt)

                    const resolution = await this.vouching.challengeResolution(this.challengeID)
                    RESOLUTION[resolution.toNumber()].should.be.equal('SUSTAINED')
                  })

                  it('decreases the amount of blocked tokens', async function () {
                    const previousVoucherBlocked = await this.vouching.blocked(this.id, voucher)
                    const previousOwnerBlocked = await this.vouching.blocked(this.id, entryOwner)
                    const previousTotalBlocked = await this.vouching.totalBlocked(this.id)

                    await this.vouching.sustain(this.challengeID, { from })

                    const voucherBlockedAmount = await this.vouching.blocked(this.id, voucher)
                    voucherBlockedAmount.should.be.bignumber.equal(previousVoucherBlocked.minus(this.voucherChallengedAmount))

                    const ownerBlockedAmount = await this.vouching.blocked(this.id, entryOwner)
                    ownerBlockedAmount.should.be.bignumber.equal(previousOwnerBlocked.minus(this.ownerChallengedAmount))

                    const totalBlocked = await this.vouching.totalBlocked(this.id)
                    totalBlocked.should.be.bignumber.equal(previousTotalBlocked.minus(this.challengeAmount))
                  })

                  it('increases the amount of available tokens', async function () {
                    const previousVoucherAvailable = await this.vouching.available(this.id, voucher)
                    const previousOwnerAvailable = await this.vouching.available(this.id, entryOwner)
                    const previousTotalAvailable = await this.vouching.totalAvailable(this.id)

                    await this.vouching.sustain(this.challengeID, { from })

                    const voucherAvailableAmount = await this.vouching.available(this.id, voucher)
                    voucherAvailableAmount.should.be.bignumber.equal(previousVoucherAvailable.plus(this.voucherChallengedAmount.times(2).minus(this.voucherAppealedAmount)))

                    const ownerAvailableAmount = await this.vouching.available(this.id, entryOwner)
                    ownerAvailableAmount.should.be.bignumber.equal(previousOwnerAvailable.plus(this.ownerChallengedAmount.times(2).minus(this.ownerAppealedAmount)))

                    const totalAvailable = await this.vouching.totalAvailable(this.id)
                    totalAvailable.should.be.bignumber.equal(previousTotalAvailable.plus(this.challengeAmount.times(2).minus(this.appealAmount)))
                  })

                  it('increases the amount of vouched tokens', async function () {
                    const previousVoucherVouched = await this.vouching.vouched(this.id, voucher)
                    const previousOwnerVouched = await this.vouching.vouched(this.id, entryOwner)
                    const previousTotalVouched = await this.vouching.totalVouched(this.id)

                    await this.vouching.sustain(this.challengeID, { from })

                    const voucherVouchedAmount = await this.vouching.vouched(this.id, voucher)
                    voucherVouchedAmount.should.be.bignumber.equal(previousVoucherVouched.plus(this.voucherChallengedAmount).minus(this.voucherAppealedAmount))

                    const ownerVouchedAmount = await this.vouching.vouched(this.id, entryOwner)
                    ownerVouchedAmount.should.be.bignumber.equal(previousOwnerVouched.plus(this.ownerChallengedAmount).minus(this.ownerAppealedAmount))

                    const totalVouched = await this.vouching.totalVouched(this.id)
                    totalVouched.should.be.bignumber.equal(previousTotalVouched.plus(this.challengeAmount).minus(this.appealAmount))
                  })

                  it('transfers the payout tokens only to the appealer', async function () {
                    const previousAppealerBalance = await this.token.balanceOf(appealer)
                    const previousChallengerBalance = await this.token.balanceOf(challenger)
                    const previousVouchingBalance = await this.token.balanceOf(this.vouching.address)

                    await this.vouching.sustain(this.challengeID, { from })

                    const currentAppealerBalance = await this.token.balanceOf(appealer)
                    currentAppealerBalance.should.be.bignumber.eq(previousAppealerBalance.plus(this.appealAmount.times(2)))

                    const currentChallengerBalance = await this.token.balanceOf(challenger)
                    currentChallengerBalance.should.be.bignumber.eq(previousChallengerBalance)

                    const currentVouchingBalance = await this.token.balanceOf(this.vouching.address)
                    currentVouchingBalance.should.be.bignumber.eq(previousVouchingBalance.minus(this.appealAmount.times(2)))
                  })
                }

                context('when there was no ongoing challenges', function () {
                  context('when there was no previous challenge', function () {
                    itShouldHandleSustainsProperly()
                  })

                  context('when there was a previous challenge', function () {
                    context('when there was an accepted previous challenge', function () {
                      beforeEach('pay a previous accepted challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.accept(challengeID, { from: entryOwner })
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleSustainsProperly()
                    })

                    context('when there was a rejected previous challenge', function () {
                      beforeEach('charge a previous rejected challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.reject(challengeID, { from: entryOwner })
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleSustainsProperly()
                    })
                  })
                })

                context('when there was an ongoing challenges', function () {
                  beforeEach('create challenge', async function () {
                    await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                  })

                  context('when there was no previous challenge', function () {
                    itShouldHandleSustainsProperly()
                  })

                  context('when there was a previous challenge', function () {
                    context('when there was an accepted previous challenge', function () {
                      beforeEach('pay a previous accepted challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.accept(challengeID, {from: entryOwner})
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleSustainsProperly()
                    })

                    context('when there was a rejected previous challenge', function () {
                      beforeEach('charge a previous rejected challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.reject(challengeID, { from: entryOwner })
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleSustainsProperly()
                    })
                  })
                })
              })

              context('when the challenge was overruled', function () {
                registerAppealedAcceptedChallenge()

                beforeEach('overrule challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.sustain(this.challengeID, { from }))
                })
              })

              context('when the challenge was sustained', function () {
                registerAppealedAcceptedChallenge()

                beforeEach('sustain challenge', async function () {
                  await this.vouching.sustain(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.sustain(this.challengeID, { from }))
                })
              })
            })
          })
        })

        context('when the challenge was not answered', function() {
          registerChallenge()

          context('when the answer period is still open', function () {
            it('reverts', async function () {
              await assertRevert(this.vouching.sustain(this.challengeID, { from }))
            })
          })

          context('when the answer period is closed', function () {
            beforeEach('travel after the answer period', async function () {
              await timeTravel(ANSWER_WINDOW_SECONDS + 1)
            })

            it('reverts', async function () {
              await assertRevert(this.vouching.sustain(this.challengeID, { from }))
            })
          })
        })
      })

      context('when the sender is not the overseer', function () {
        registerChallenge()

        beforeEach('answer and appeal challenge', async function () {
          await this.vouching.reject(this.challengeID, { from: entryOwner })
          await this.vouching.appeal(this.challengeID, { from: voucher })
        })

        it('reverts', async function () {
          await assertRevert(this.vouching.sustain(this.challengeID, { from: anyone }))
        })
      })
    })

    context('when the challenge id does not exist', function () {
      it('reverts', async function () {
        await assertRevert(this.vouching.sustain(0, { from: overseer }))
      })
    })
  })

  describe('overrule', function () {
    const VOUCHER_AMOUNT = zep(5)

    beforeEach('register an entry and vouch', async function () {
      const receipt = await this.vouching.register(this.entryAddress, MINIMUM_STAKE.times(2), METADATA_URI, METADATA_HASH, { from: entryOwner })
      this.id = receipt.logs[0].args.id
      await this.vouching.vouch(this.id, VOUCHER_AMOUNT, { from: voucher })
    })

    context('when the challenge id exists', function () {
      const CHALLENGE_FEE = pct(1)
      const CHALLENGE_METADATA_URI = 'challenge uri'
      const CHALLENGE_METADATA_HASH = '0x3a00000000000000000000000000000000000000000000000000000000000001'

      const registerChallenge = function () {
        beforeEach('register a challenge', async function () {
          const previousTotalAvailable = await this.vouching.totalAvailable(this.id)
          const previousOwnerAvailable = await this.vouching.available(this.id, entryOwner)
          const previousVoucherAvailable = await this.vouching.available(this.id, voucher)

          const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, CHALLENGE_METADATA_URI, CHALLENGE_METADATA_HASH, {from: challenger})
          this.challengeID = receipt.logs[0].args.challengeID
          this.challengeAmount = receipt.logs[0].args.amount
          this.appealAmount = this.challengeAmount.mul(APPEAL_FEE).div(PCT_BASE)
          this.ownerAppealedAmount = this.appealAmount.times(previousOwnerAvailable).div(previousTotalAvailable)
          this.ownerChallengedAmount = this.challengeAmount.times(previousOwnerAvailable).div(previousTotalAvailable)
          this.voucherAppealedAmount = this.appealAmount.times(previousVoucherAvailable).div(previousTotalAvailable)
          this.voucherChallengedAmount = this.challengeAmount.times(previousVoucherAvailable).div(previousTotalAvailable)
        })
      }

      context('when the sender is the overseer', function () {
        const from = overseer

        context('when the challenge was answered', function() {
          context('when the challenge was rejected', function () {
            const registerRejectedChallenge = function () {
              registerChallenge()

              beforeEach('reject the challenge', async function () {
                await this.vouching.reject(this.challengeID, { from: entryOwner })
              })
            }

            context('when the challenge was not appealed nor confirmed', function () {
              registerRejectedChallenge()

              context('when the challenge is within the appeal period', function () {
                it('reverts', async function () {
                  await assertRevert(this.vouching.overrule(this.challengeID, { from }))
                })
              })

              context('when the challenge is out of the appeal period', function () {
                beforeEach('travel after the appeal period', async function () {
                  await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.overrule(this.challengeID, { from }))
                })
              })
            })

            context('when the challenge was confirmed', function () {
              registerRejectedChallenge()

              beforeEach('travel after appeal window and confirm challenge', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(this.challengeID)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.overrule(this.challengeID, { from }))
              })
            })

            context('when the challenge was appealed', function () {
              const appealer = anyone

              const registerAppealedRejectedChallenge = function () {
                registerRejectedChallenge()

                beforeEach('appeal challenge', async function () {
                  await this.vouching.appeal(this.challengeID, { from: appealer })
                })
              }

              context('when the challenge was not resolved', function () {
                const itShouldHandleOverrulesProperly = function () {
                  registerAppealedRejectedChallenge()

                  it('emits an Overruled event', async function () {
                    const receipt = await this.vouching.overrule(this.challengeID, { from })

                    const event = assertEvent.inLogs(receipt.logs, 'Overruled')
                    event.args.challengeID.should.be.bignumber.eq(this.challengeID)
                    event.args.overseer.should.be.bignumber.eq(from)
                  })

                  it('stores the resolution without changing the rest of the status', async function () {
                    const answeredAt = (await this.vouching.challengeAnswer(this.challengeID))[1]
                    const appealedAt = (await this.vouching.challengeAppeal(this.challengeID))[2]

                    await this.vouching.overrule(this.challengeID, { from })

                    const answerData = await this.vouching.challengeAnswer(this.challengeID)
                    ANSWER[answerData[0].toNumber()].should.be.equal('REJECTED')
                    answerData[1].should.be.bignumber.equal(answeredAt)

                    const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
                    challengeTarget.should.be.bignumber.equal(this.id)

                    const challengeOwner = await this.vouching.challenger(this.challengeID)
                    challengeOwner.should.be.equal(challenger)

                    const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
                    challengeAmount.should.be.bignumber.equal(this.challengeAmount)

                    const appealData = await this.vouching.challengeAppeal(this.challengeID)
                    appealData[0].should.equal(appealer)
                    appealData[1].should.be.bignumber.equal(this.appealAmount)
                    appealData[2].should.be.bignumber.equal(appealedAt)

                    const resolution = await this.vouching.challengeResolution(this.challengeID)
                    RESOLUTION[resolution.toNumber()].should.be.equal('OVERRULED')
                  })

                  it('decreases the amount of blocked tokens', async function () {
                    const previousVoucherBlocked = await this.vouching.blocked(this.id, voucher)
                    const previousOwnerBlocked = await this.vouching.blocked(this.id, entryOwner)
                    const previousTotalBlocked = await this.vouching.totalBlocked(this.id)

                    await this.vouching.overrule(this.challengeID, { from })

                    const voucherBlockedAmount = await this.vouching.blocked(this.id, voucher)
                    voucherBlockedAmount.should.be.bignumber.equal(previousVoucherBlocked.minus(this.voucherChallengedAmount))

                    const ownerBlockedAmount = await this.vouching.blocked(this.id, entryOwner)
                    ownerBlockedAmount.should.be.bignumber.equal(previousOwnerBlocked.minus(this.ownerChallengedAmount))

                    const totalBlocked = await this.vouching.totalBlocked(this.id)
                    totalBlocked.should.be.bignumber.equal(previousTotalBlocked.minus(this.challengeAmount))
                  })

                  it('increases the amount of vouched tokens', async function () {
                    const previousVoucherVouched = await this.vouching.vouched(this.id, voucher)
                    const previousOwnerVouched = await this.vouching.vouched(this.id, entryOwner)
                    const previousTotalVouched = await this.vouching.totalVouched(this.id)

                    await this.vouching.overrule(this.challengeID, { from })

                    const voucherVouchedAmount = await this.vouching.vouched(this.id, voucher)
                    voucherVouchedAmount.should.be.bignumber.equal(previousVoucherVouched.plus(this.voucherChallengedAmount).plus(this.voucherAppealedAmount))

                    const ownerVouchedAmount = await this.vouching.vouched(this.id, entryOwner)
                    ownerVouchedAmount.should.be.bignumber.equal(previousOwnerVouched.plus(this.ownerChallengedAmount).plus(this.ownerAppealedAmount))

                    const totalVouched = await this.vouching.totalVouched(this.id)
                    totalVouched.should.be.bignumber.equal(previousTotalVouched.plus(this.challengeAmount).plus(this.appealAmount))
                  })

                  it('increases the amount of available tokens', async function () {
                    const previousVoucherAvailable = await this.vouching.available(this.id, voucher)
                    const previousOwnerAvailable = await this.vouching.available(this.id, entryOwner)
                    const previousTotalAvailable = await this.vouching.totalAvailable(this.id)

                    await this.vouching.overrule(this.challengeID, { from })

                    const voucherAvailableAmount = await this.vouching.available(this.id, voucher)
                    voucherAvailableAmount.should.be.bignumber.equal(previousVoucherAvailable.plus(this.voucherChallengedAmount.times(2)).plus(this.voucherAppealedAmount))

                    const ownerAvailableAmount = await this.vouching.available(this.id, entryOwner)
                    ownerAvailableAmount.should.be.bignumber.equal(previousOwnerAvailable.plus(this.ownerChallengedAmount.times(2)).plus(this.ownerAppealedAmount))

                    const totalAvailable = await this.vouching.totalAvailable(this.id)
                    totalAvailable.should.be.bignumber.equal(previousTotalAvailable.plus(this.challengeAmount.times(2)).plus(this.appealAmount))
                  })

                  it('does not transfer payout tokens', async function () {
                    const previousAppealerBalance = await this.token.balanceOf(appealer)
                    const previousChallengerBalance = await this.token.balanceOf(challenger)
                    const previousVouchingBalance = await this.token.balanceOf(this.vouching.address)

                    await this.vouching.overrule(this.challengeID, { from })

                    const currentAppealerBalance = await this.token.balanceOf(appealer)
                    currentAppealerBalance.should.be.bignumber.eq(previousAppealerBalance)

                    const currentChallengerBalance = await this.token.balanceOf(challenger)
                    currentChallengerBalance.should.be.bignumber.eq(previousChallengerBalance)

                    const currentVouchingBalance = await this.token.balanceOf(this.vouching.address)
                    currentVouchingBalance.should.be.bignumber.eq(previousVouchingBalance)
                  })
                }

                context('when there was no ongoing challenges', function () {
                  context('when there was no previous challenge', function () {
                    itShouldHandleOverrulesProperly()
                  })

                  context('when there was a previous challenge', function () {
                    context('when there was an accepted previous challenge', function () {
                      beforeEach('pay a previous accepted challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.accept(challengeID, { from: entryOwner })
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleOverrulesProperly()
                    })

                    context('when there was a rejected previous challenge', function () {
                      beforeEach('charge a previous rejected challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.reject(challengeID, { from: entryOwner })
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleOverrulesProperly()
                    })
                  })
                })

                context('when there was an ongoing challenges', function () {
                  beforeEach('create challenge', async function () {
                    await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                  })

                  context('when there was no previous challenge', function () {
                    itShouldHandleOverrulesProperly()
                  })

                  context('when there was a previous challenge', function () {
                    context('when there was an accepted previous challenge', function () {
                      beforeEach('pay a previous accepted challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.accept(challengeID, {from: entryOwner})
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleOverrulesProperly()
                    })

                    context('when there was a rejected previous challenge', function () {
                      beforeEach('charge a previous rejected challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.reject(challengeID, { from: entryOwner })
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleOverrulesProperly()
                    })
                  })
                })
              })

              context('when the challenge was overruled', function () {
                registerAppealedRejectedChallenge()

                beforeEach('overrule challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.overrule(this.challengeID, { from }))
                })
              })

              context('when the challenge was sustained', function () {
                registerAppealedRejectedChallenge()

                beforeEach('sustain challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.overrule(this.challengeID, { from }))
                })
              })
            })
          })

          context('when the challenge was accepted', function () {
            const registerAcceptedChallenge = function () {
              registerChallenge()

              beforeEach('accept the challenge', async function () {
                await this.vouching.accept(this.challengeID, { from: entryOwner })
              })
            }

            context('when the challenge was not appealed nor confirmed', function () {
              registerAcceptedChallenge()

              context('when the challenge is within the appeal period', function () {
                it('reverts', async function () {
                  await assertRevert(this.vouching.overrule(this.challengeID, { from }))
                })
              })

              context('when the challenge is out of the appeal period', function () {
                beforeEach('travel after the appeal period', async function () {
                  await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.overrule(this.challengeID, { from }))
                })
              })
            })

            context('when the challenge was confirmed', function () {
              registerAcceptedChallenge()

              beforeEach('travel after appeal window and confirm challenge', async function () {
                await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                await this.vouching.confirm(this.challengeID)
              })

              it('reverts', async function () {
                await assertRevert(this.vouching.overrule(this.challengeID, { from }))
              })
            })

            context('when the challenge was appealed', function () {
              const appealer = anyone

              const registerAppealedAcceptedChallenge = function () {
                registerAcceptedChallenge()

                beforeEach('appeal challenge', async function () {
                  await this.vouching.appeal(this.challengeID, { from: appealer })
                })
              }

              context('when the challenge was not resolved', function () {
                const itShouldHandleOverrulesProperly = function () {
                  registerAppealedAcceptedChallenge()

                  it('stores the resolution without changing the rest of the status', async function () {
                    const answeredAt = (await this.vouching.challengeAnswer(this.challengeID))[1]
                    const appealedAt = (await this.vouching.challengeAppeal(this.challengeID))[2]

                    await this.vouching.overrule(this.challengeID, { from })

                    const answerData = await this.vouching.challengeAnswer(this.challengeID)
                    ANSWER[answerData[0].toNumber()].should.be.equal('ACCEPTED')
                    answerData[1].should.be.bignumber.equal(answeredAt)

                    const challengeTarget = await this.vouching.challengeTarget(this.challengeID)
                    challengeTarget.should.be.bignumber.equal(this.id)

                    const challengeOwner = await this.vouching.challenger(this.challengeID)
                    challengeOwner.should.be.equal(challenger)

                    const challengeAmount = await this.vouching.challengeAmount(this.challengeID)
                    challengeAmount.should.be.bignumber.equal(this.challengeAmount)

                    const appealData = await this.vouching.challengeAppeal(this.challengeID)
                    appealData[0].should.equal(appealer)
                    appealData[1].should.be.bignumber.equal(this.appealAmount)
                    appealData[2].should.be.bignumber.equal(appealedAt)

                    const resolution = await this.vouching.challengeResolution(this.challengeID)
                    RESOLUTION[resolution.toNumber()].should.be.equal('OVERRULED')
                  })

                  it('emits an Overruled event', async function () {
                    const receipt = await this.vouching.overrule(this.challengeID, { from })

                    const event = assertEvent.inLogs(receipt.logs, 'Overruled')
                    event.args.challengeID.should.be.bignumber.eq(this.challengeID)
                    event.args.overseer.should.be.bignumber.eq(from)
                  })

                  it('decreases the amount of blocked tokens', async function () {
                    const previousVoucherBlocked = await this.vouching.blocked(this.id, voucher)
                    const previousOwnerBlocked = await this.vouching.blocked(this.id, entryOwner)
                    const previousTotalBlocked = await this.vouching.totalBlocked(this.id)

                    await this.vouching.overrule(this.challengeID, { from })

                    const voucherBlockedAmount = await this.vouching.blocked(this.id, voucher)
                    voucherBlockedAmount.should.be.bignumber.equal(previousVoucherBlocked.minus(this.voucherChallengedAmount))

                    const ownerBlockedAmount = await this.vouching.blocked(this.id, entryOwner)
                    ownerBlockedAmount.should.be.bignumber.equal(previousOwnerBlocked.minus(this.ownerChallengedAmount))

                    const totalBlocked = await this.vouching.totalBlocked(this.id)
                    totalBlocked.should.be.bignumber.equal(previousTotalBlocked.minus(this.challengeAmount))
                  })

                  it('decreases the amount of vouched tokens', async function () {
                    const previousVoucherVouched = await this.vouching.vouched(this.id, voucher)
                    const previousOwnerVouched = await this.vouching.vouched(this.id, entryOwner)
                    const previousTotalVouched = await this.vouching.totalVouched(this.id)

                    await this.vouching.overrule(this.challengeID, { from })

                    const voucherVouchedAmount = await this.vouching.vouched(this.id, voucher)
                    voucherVouchedAmount.should.be.bignumber.equal(previousVoucherVouched.minus(this.voucherChallengedAmount).plus(this.voucherAppealedAmount))

                    const ownerVouchedAmount = await this.vouching.vouched(this.id, entryOwner)
                    ownerVouchedAmount.should.be.bignumber.equal(previousOwnerVouched.minus(this.ownerChallengedAmount).plus(this.ownerAppealedAmount))

                    const totalVouched = await this.vouching.totalVouched(this.id)
                    totalVouched.should.be.bignumber.equal(previousTotalVouched.minus(this.challengeAmount).plus(this.appealAmount))
                  })

                  it('increases the amount of available tokens', async function () {
                    const previousVoucherAvailable = await this.vouching.available(this.id, voucher)
                    const previousOwnerAvailable = await this.vouching.available(this.id, entryOwner)
                    const previousTotalAvailable = await this.vouching.totalAvailable(this.id)

                    await this.vouching.overrule(this.challengeID, { from })

                    const voucherAvailableAmount = await this.vouching.available(this.id, voucher)
                    voucherAvailableAmount.should.be.bignumber.equal(previousVoucherAvailable.plus(this.voucherAppealedAmount))

                    const ownerAvailableAmount = await this.vouching.available(this.id, entryOwner)
                    ownerAvailableAmount.should.be.bignumber.equal(previousOwnerAvailable.plus(this.ownerAppealedAmount))

                    const totalAvailable = await this.vouching.totalAvailable(this.id)
                    totalAvailable.should.be.bignumber.equal(previousTotalAvailable.plus(this.appealAmount))
                  })

                  it('transfers the payout tokens only to the challenger', async function () {
                    const previousAppealerBalance = await this.token.balanceOf(appealer)
                    const previousChallengerBalance = await this.token.balanceOf(challenger)
                    const previousVouchingBalance = await this.token.balanceOf(this.vouching.address)

                    await this.vouching.overrule(this.challengeID, { from })

                    const currentAppealerBalance = await this.token.balanceOf(appealer)
                    currentAppealerBalance.should.be.bignumber.eq(previousAppealerBalance)

                    const currentChallengerBalance = await this.token.balanceOf(challenger)
                    currentChallengerBalance.should.be.bignumber.eq(previousChallengerBalance.plus(this.challengeAmount.times(2)))

                    const currentVouchingBalance = await this.token.balanceOf(this.vouching.address)
                    currentVouchingBalance.should.be.bignumber.eq(previousVouchingBalance.minus(this.challengeAmount.times(2)))
                  })
                }

                context('when there was no ongoing challenges', function () {
                  context('when there was no previous challenge', function () {
                    itShouldHandleOverrulesProperly()
                  })

                  context('when there was a previous challenge', function () {
                    context('when there was an accepted previous challenge', function () {
                      beforeEach('pay a previous accepted challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.accept(challengeID, { from: entryOwner })
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleOverrulesProperly()
                    })

                    context('when there was a rejected previous challenge', function () {
                      beforeEach('charge a previous rejected challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.reject(challengeID, { from: entryOwner })
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleOverrulesProperly()
                    })
                  })
                })

                context('when there was an ongoing challenges', function () {
                  beforeEach('create challenge', async function () {
                    await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                  })

                  context('when there was no previous challenge', function () {
                    itShouldHandleOverrulesProperly()
                  })

                  context('when there was a previous challenge', function () {
                    context('when there was an accepted previous challenge', function () {
                      beforeEach('pay a previous accepted challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', {from: challenger})
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.accept(challengeID, {from: entryOwner})
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleOverrulesProperly()
                    })

                    context('when there was a rejected previous challenge', function () {
                      beforeEach('charge a previous rejected challenge', async function () {
                        const receipt = await this.vouching.challenge(this.id, CHALLENGE_FEE, 'challenge uri', '0x3a', { from: challenger })
                        const challengeID = receipt.logs[0].args.challengeID

                        await this.vouching.reject(challengeID, { from: entryOwner })
                        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
                        await this.vouching.confirm(challengeID)
                      })

                      itShouldHandleOverrulesProperly()
                    })
                  })
                })
              })

              context('when the challenge was overruled', function () {
                registerAppealedAcceptedChallenge()

                beforeEach('overrule challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.overrule(this.challengeID, { from }))
                })
              })

              context('when the challenge was sustained', function () {
                registerAppealedAcceptedChallenge()

                beforeEach('sustain challenge', async function () {
                  await this.vouching.overrule(this.challengeID, { from: overseer })
                })

                it('reverts', async function () {
                  await assertRevert(this.vouching.overrule(this.challengeID, { from }))
                })
              })
            })
          })
        })

        context('when the challenge was not answered', function() {
          registerChallenge()

          context('when the answer period is still open', function () {
            it('reverts', async function () {
              await assertRevert(this.vouching.overrule(this.challengeID, { from }))
            })
          })

          context('when the answer period is closed', function () {
            beforeEach('travel after the answer period', async function () {
              await timeTravel(ANSWER_WINDOW_SECONDS + 1)
            })

            it('reverts', async function () {
              await assertRevert(this.vouching.overrule(this.challengeID, { from }))
            })
          })
        })
      })

      context('when the sender is not the overseer', function () {
        registerChallenge()

        beforeEach('answer and appeal challenge', async function () {
          await this.vouching.reject(this.challengeID, { from: entryOwner })
          await this.vouching.appeal(this.challengeID, { from: voucher })
        })

        it('reverts', async function () {
          await assertRevert(this.vouching.overrule(this.challengeID, { from: anyone }))
        })
      })
    })

    context('when the challenge id does not exist', function () {
      it('reverts', async function () {
        await assertRevert(this.vouching.overrule(0, { from: overseer }))
      })
    })
  })

  xdescribe('transferOwnership', function () {
    const from = entryOwner

    beforeEach('register an entry', async function () {
      const receipt = await this.vouching.register(this.entryAddress, MINIMUM_STAKE, METADATA_URI, METADATA_HASH, { from })
      this.id = receipt.logs[0].args.id
    })

    it('reverts when caller is not the entry owner', async function () {
      await assertRevert(this.vouching.transferOwnership(this.id, transferee, { from: voucher }))
    })

    it('reverts for null new owner address', async function () {
      await assertRevert(this.vouching.transferOwnership(this.id, ZERO_ADDRESS, { from }))
    })

    it('transfers the entry ownership to a given address', async function () {
      const receipt = await this.vouching.transferOwnership(this.id, transferee, { from })

      (await this.vouching.owner(this.id)).should.equal(transferee)
      assertEvent.inLogs(receipt.logs, 'OwnershipTransferred', { oldOwner: entryOwner, newOwner: transferee })
    })
  })

  describe('edge scenarios', function () {
    let vouching, id

    context('challenges v1 - accept', function () {
      const [voucherA, voucherB, voucherC] = [anyone, voucher, entryOwner]
      const [vouchedAmountA, vouchedAmountB, vouchedAmountC] = [zep(50), zep(50), zep(100)]

      beforeEach('register entry and vouch tokens', async function () {
        vouching = this.vouching
        const receipt = await vouching.register(this.entryAddress, MINIMUM_STAKE, METADATA_URI, METADATA_HASH, { from: entryOwner })
        id = receipt.logs[0].args.id

        await vouching.vouch(id, vouchedAmountA, { from: voucherA })
        await vouching.vouch(id, vouchedAmountB, { from: voucherB })
        await vouching.vouch(id, vouchedAmountC, { from: voucherC })
      })

      it('should hold given scenario', async function () {
        await assertTotalStatus(zep(200), zep(200), zep(0))
        await assertVoucherStatus(voucherA, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherB, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherC, zep(100), zep(100), zep(0))

        // Challenge 10%
        const receipt_10 = await vouching.challenge(id, pct(10), 'challenge 10%', '0xa', { from: challenger })
        const challengeID_10 = receipt_10.logs[0].args.challengeID
        await assertTotalStatus(zep(200), zep(180), zep(20))
        await assertVoucherStatus(voucherA, zep(50), zep(45), zep(5))
        await assertVoucherStatus(voucherB, zep(50), zep(45), zep(5))
        await assertVoucherStatus(voucherC, zep(100), zep(90), zep(10))

        // Accept Challenge 10%
        await vouching.accept(challengeID_10, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_10)
        await assertTotalStatus(zep(180), zep(180), zep(0))
        await assertVoucherStatus(voucherA, zep(45), zep(45), zep(0))
        await assertVoucherStatus(voucherB, zep(45), zep(45), zep(0))
        await assertVoucherStatus(voucherC, zep(90), zep(90), zep(0))

        // Challenge 20%
        const receipt_20 = await vouching.challenge(id, pct(20), 'challenge 20%', '0xa', { from: challenger })
        const challengeID_20 = receipt_20.logs[0].args.challengeID
        await assertTotalStatus(zep(180), zep(144), zep(36))
        await assertVoucherStatus(voucherA, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherB, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherC, zep(90), zep(72), zep(18))

        // Challenge 5%
        const receipt_5 = await vouching.challenge(id, pct(5), 'challenge 5%', '0xa', { from: challenger })
        const challengeID_5 = receipt_5.logs[0].args.challengeID
        await assertTotalStatus(zep(180), zep(136.8), zep(43.2))
        await assertVoucherStatus(voucherA, zep(45), zep(34.2), zep(10.8))
        await assertVoucherStatus(voucherB, zep(45), zep(34.2), zep(10.8))
        await assertVoucherStatus(voucherC, zep(90), zep(68.4), zep(21.6))

        // Accept Challenge 5%
        await vouching.accept(challengeID_5, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_5)
        await assertTotalStatus(zep(172.8), zep(136.8), zep(36))
        await assertVoucherStatus(voucherA, zep(43.2), zep(34.2), zep(9))
        await assertVoucherStatus(voucherB, zep(43.2), zep(34.2), zep(9))
        await assertVoucherStatus(voucherC, zep(86.4), zep(68.4), zep(18))

        // Challenge 50%
        const receipt_50 = await vouching.challenge(id, pct(50), 'challenge 50%', '0xa', { from: challenger })
        const challengeID_50 = receipt_50.logs[0].args.challengeID
        await assertTotalStatus(zep(172.8), zep(68.4), zep(104.4))
        await assertVoucherStatus(voucherA, zep(43.2), zep(17.1), zep(26.1))
        await assertVoucherStatus(voucherB, zep(43.2), zep(17.1), zep(26.1))
        await assertVoucherStatus(voucherC, zep(86.4), zep(34.2), zep(52.2))

        // Challenge 90%
        const receipt_90 = await vouching.challenge(id, pct(90), 'challenge 90%', '0xa', { from: challenger })
        const challengeID_90 = receipt_90.logs[0].args.challengeID
        await assertTotalStatus(zep(172.8), zep(6.84), zep(165.96))
        await assertVoucherStatus(voucherA, zep(43.2), zep(1.71), zep(41.49))
        await assertVoucherStatus(voucherB, zep(43.2), zep(1.71), zep(41.49))
        await assertVoucherStatus(voucherC, zep(86.4), zep(3.42), zep(82.98))

        // Accept Challenge 90%
        await vouching.accept(challengeID_90, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_90)
        await assertTotalStatus(zep(111.24), zep(6.84), zep(104.4))
        await assertVoucherStatus(voucherA, zep(27.81), zep(1.71), zep(26.1))
        await assertVoucherStatus(voucherB, zep(27.81), zep(1.71), zep(26.1))
        await assertVoucherStatus(voucherC, zep(55.62), zep(3.42), zep(52.2))
      })
    })

    context('challenges v2 - accept/reject', function () {
      const [voucherA, voucherB, voucherC] = [anyone, voucher, entryOwner]
      const [vouchedAmountA, vouchedAmountB, vouchedAmountC] = [zep(50), zep(50), zep(100)]

      beforeEach('register entry and vouch tokens', async function () {
        vouching = this.vouching
        const receipt = await vouching.register(this.entryAddress, MINIMUM_STAKE, METADATA_URI, METADATA_HASH, { from: entryOwner })
        id = receipt.logs[0].args.id

        await vouching.vouch(id, vouchedAmountA, { from: voucherA })
        await vouching.vouch(id, vouchedAmountB, { from: voucherB })
        await vouching.vouch(id, vouchedAmountC, { from: voucherC })
      })

      it('should hold given scenario', async function () {
        await assertTotalStatus(zep(200), zep(200), zep(0))
        await assertVoucherStatus(voucherA, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherB, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherC, zep(100), zep(100), zep(0))

        // Challenge 10%
        const receipt_10 = await vouching.challenge(id, pct(10), 'challenge 10%', '0xa', { from: challenger })
        const challengeID_10 = receipt_10.logs[0].args.challengeID
        await assertTotalStatus(zep(200), zep(180), zep(20))
        await assertVoucherStatus(voucherA, zep(50), zep(45), zep(5))
        await assertVoucherStatus(voucherB, zep(50), zep(45), zep(5))
        await assertVoucherStatus(voucherC, zep(100), zep(90), zep(10))

        // Accept Challenge 10%
        await vouching.accept(challengeID_10, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_10)
        await assertTotalStatus(zep(180), zep(180), zep(0))
        await assertVoucherStatus(voucherA, zep(45), zep(45), zep(0))
        await assertVoucherStatus(voucherB, zep(45), zep(45), zep(0))
        await assertVoucherStatus(voucherC, zep(90), zep(90), zep(0))

        // Challenge 20%
        const receipt_20 = await vouching.challenge(id, pct(20), 'challenge 20%', '0xa', { from: challenger })
        const challengeID_20 = receipt_20.logs[0].args.challengeID
        await assertTotalStatus(zep(180), zep(144), zep(36))
        await assertVoucherStatus(voucherA, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherB, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherC, zep(90), zep(72), zep(18))

        // Challenge 5%
        const receipt_5 = await vouching.challenge(id, pct(5), 'challenge 5%', '0xa', { from: challenger })
        const challengeID_5 = receipt_5.logs[0].args.challengeID
        await assertTotalStatus(zep(180), zep(136.8), zep(43.2))
        await assertVoucherStatus(voucherA, zep(45), zep(34.2), zep(10.8))
        await assertVoucherStatus(voucherB, zep(45), zep(34.2), zep(10.8))
        await assertVoucherStatus(voucherC, zep(90), zep(68.4), zep(21.6))

        // Reject Challenge 5%
        await vouching.reject(challengeID_5, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_5)
        await assertTotalStatus(zep(187.2), zep(151.2), zep(36))
        await assertVoucherStatus(voucherA, zep(46.8), zep(37.8), zep(9))
        await assertVoucherStatus(voucherB, zep(46.8), zep(37.8), zep(9))
        await assertVoucherStatus(voucherC, zep(93.6), zep(75.6), zep(18))

        // Challenge 50%
        const receipt_50 = await vouching.challenge(id, pct(50), 'challenge 50%', '0xa', { from: challenger })
        const challengeID_50 = receipt_50.logs[0].args.challengeID
        await assertTotalStatus(zep(187.2), zep(75.6), zep(111.6))
        await assertVoucherStatus(voucherA, zep(46.8), zep(18.9), zep(27.9))
        await assertVoucherStatus(voucherB, zep(46.8), zep(18.9), zep(27.9))
        await assertVoucherStatus(voucherC, zep(93.6), zep(37.8), zep(55.8))

        // Challenge 90%
        const receipt_90 = await vouching.challenge(id, pct(90), 'challenge 90%', '0xa', { from: challenger })
        const challengeID_90 = receipt_90.logs[0].args.challengeID
        await assertTotalStatus(zep(187.2), zep(7.56), zep(179.64))
        await assertVoucherStatus(voucherA, zep(46.8), zep(1.89), zep(44.91))
        await assertVoucherStatus(voucherB, zep(46.8), zep(1.89), zep(44.91))
        await assertVoucherStatus(voucherC, zep(93.6), zep(3.78), zep(89.82))

        // Accept Challenge 90%
        await vouching.accept(challengeID_90, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_90)
        await assertTotalStatus(zep(119.16), zep(7.56), zep(111.6))
        await assertVoucherStatus(voucherA, zep(29.79), zep(1.89), zep(27.9))
        await assertVoucherStatus(voucherB, zep(29.79), zep(1.89), zep(27.9))
        await assertVoucherStatus(voucherC, zep(59.58), zep(3.78), zep(55.8))
      })
    })

    context('challenge 100%', function () {
      const [voucherA, voucherB, voucherC] = [anyone, voucher, entryOwner]
      const [vouchedAmountA, vouchedAmountB, vouchedAmountC] = [zep(50), zep(50), zep(100)]

      beforeEach('register entry and vouch tokens', async function () {
        vouching = this.vouching
        const receipt = await vouching.register(this.entryAddress, MINIMUM_STAKE, METADATA_URI, METADATA_HASH, { from: entryOwner })
        id = receipt.logs[0].args.id

        await vouching.vouch(id, vouchedAmountA, { from: voucherA })
        await vouching.vouch(id, vouchedAmountB, { from: voucherB })
        await vouching.vouch(id, vouchedAmountC, { from: voucherC })
      })

      it('should hold given scenario', async function () {
        await assertTotalStatus(zep(200), zep(200), zep(0))
        await assertVoucherStatus(voucherA, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherB, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherC, zep(100), zep(100), zep(0))

        // Challenge 10%
        const receipt_10 = await vouching.challenge(id, pct(10), 'challenge 10%', '0xa', { from: challenger })
        const challengeID_10 = receipt_10.logs[0].args.challengeID
        await assertTotalStatus(zep(200), zep(180), zep(20))
        await assertVoucherStatus(voucherA, zep(50), zep(45), zep(5))
        await assertVoucherStatus(voucherB, zep(50), zep(45), zep(5))
        await assertVoucherStatus(voucherC, zep(100), zep(90), zep(10))

        // Accept Challenge 10%
        await vouching.accept(challengeID_10, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_10)
        await assertTotalStatus(zep(180), zep(180), zep(0))
        await assertVoucherStatus(voucherA, zep(45), zep(45), zep(0))
        await assertVoucherStatus(voucherB, zep(45), zep(45), zep(0))
        await assertVoucherStatus(voucherC, zep(90), zep(90), zep(0))

        // Challenge 20%
        const receipt_20 = await vouching.challenge(id, pct(20), 'challenge 20%', '0xa', { from: challenger })
        const challengeID_20 = receipt_20.logs[0].args.challengeID
        await assertTotalStatus(zep(180), zep(144), zep(36))
        await assertVoucherStatus(voucherA, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherB, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherC, zep(90), zep(72), zep(18))

        // Challenge 100%
        const receipt_100 = await vouching.challenge(id, pct(100), 'challenge 100%', '0xa', { from: challenger })
        const challengeID_100 = receipt_100.logs[0].args.challengeID
        await assertTotalStatus(zep(180), zep(0), zep(180))
        await assertVoucherStatus(voucherA, zep(45), zep(0), zep(45))
        await assertVoucherStatus(voucherB, zep(45), zep(0), zep(45))
        await assertVoucherStatus(voucherC, zep(90), zep(0), zep(90))

        // Accept 100%
        await vouching.accept(challengeID_100, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_100)
        await assertTotalStatus(zep(36), zep(0), zep(36))
        await assertVoucherStatus(voucherA, zep(9), zep(0), zep(9))
        await assertVoucherStatus(voucherB, zep(9), zep(0), zep(9))
        await assertVoucherStatus(voucherC, zep(18), zep(0), zep(18))
      })
    })

    context('rate 0', function () {
      const [voucherA, voucherB, voucherC] = [anyone, voucher, entryOwner]
      const [vouchedAmountA, vouchedAmountB, vouchedAmountC] = [zep(50), zep(50), zep(100)]

      beforeEach('register entry and vouch tokens', async function () {
        vouching = this.vouching
        const receipt = await vouching.register(this.entryAddress, MINIMUM_STAKE, METADATA_URI, METADATA_HASH, { from: entryOwner })
        id = receipt.logs[0].args.id

        await vouching.vouch(id, vouchedAmountA, { from: voucherA })
        await vouching.vouch(id, vouchedAmountB, { from: voucherB })
        await vouching.vouch(id, vouchedAmountC, { from: voucherC })
      })

      it('should hold given scenario', async function () {
        await assertTotalStatus(zep(200), zep(200), zep(0))
        await assertVoucherStatus(voucherA, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherB, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherC, zep(100), zep(100), zep(0))

        // Challenge 100%
        const receipt_100 = await vouching.challenge(id, pct(100), 'challenge 100%', '0xa', { from: challenger })
        const challengeID_100 = receipt_100.logs[0].args.challengeID
        await assertTotalStatus(zep(200), zep(0), zep(200))
        await assertVoucherStatus(voucherA, zep(50), zep(0), zep(50))
        await assertVoucherStatus(voucherB, zep(50), zep(0), zep(50))
        await assertVoucherStatus(voucherC, zep(100), zep(0), zep(100))

        // Accept Challenge 100%
        await vouching.accept(challengeID_100, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_100)
        await assertTotalStatus(zep(0), zep(0), zep(0))
        await assertVoucherStatus(voucherA, zep(0), zep(0), zep(0))
        await assertVoucherStatus(voucherB, zep(0), zep(0), zep(0))
        await assertVoucherStatus(voucherC, zep(0), zep(0), zep(0))

        // Challenge 20%
        await assertRevert(vouching.challenge(id, pct(20), 'challenge 20%', '0xa', { from: challenger }))
      })
    })

    context('challenges + vouching v1', function () {
      const [voucherA, voucherB, voucherC, voucherD] = [anyone, voucher, entryOwner, challenger]
      const [vouchedAmountA, vouchedAmountB, vouchedAmountC] = [zep(50), zep(50), zep(100)]

      beforeEach('register entry and vouch tokens', async function () {
        vouching = this.vouching
        const receipt = await vouching.register(this.entryAddress, MINIMUM_STAKE, METADATA_URI, METADATA_HASH, { from: entryOwner })
        id = receipt.logs[0].args.id

        await vouching.vouch(id, vouchedAmountA, { from: voucherA })
        await vouching.vouch(id, vouchedAmountB, { from: voucherB })
        await vouching.vouch(id, vouchedAmountC, { from: voucherC })
      })

      it('should hold given scenario', async function () {
        await assertTotalStatus(zep(200), zep(200), zep(0))
        await assertVoucherStatus(voucherA, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherB, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherC, zep(100), zep(100), zep(0))

        // Challenge 10%
        const receipt_10 = await vouching.challenge(id, pct(10), 'challenge 10%', '0xa', { from: challenger })
        const challengeID_10 = receipt_10.logs[0].args.challengeID
        await assertTotalStatus(zep(200), zep(180), zep(20))
        await assertVoucherStatus(voucherA, zep(50), zep(45), zep(5))
        await assertVoucherStatus(voucherB, zep(50), zep(45), zep(5))
        await assertVoucherStatus(voucherC, zep(100), zep(90), zep(10))

        // Accept Challenge 10%
        await vouching.accept(challengeID_10, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_10)
        await assertTotalStatus(zep(180), zep(180), zep(0))
        await assertVoucherStatus(voucherA, zep(45), zep(45), zep(0))
        await assertVoucherStatus(voucherB, zep(45), zep(45), zep(0))
        await assertVoucherStatus(voucherC, zep(90), zep(90), zep(0))

        // Challenge 20%
        const receipt_20 = await vouching.challenge(id, pct(20), 'challenge 20%', '0xa', { from: challenger })
        const challengeID_20 = receipt_20.logs[0].args.challengeID
        await assertTotalStatus(zep(180), zep(144), zep(36))
        await assertVoucherStatus(voucherA, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherB, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherC, zep(90), zep(72), zep(18))

        // Vouch D 180
        await vouching.vouch(id, zep(180), { from: voucherD })
        await assertTotalStatus(zep(360), zep(324), zep(36))
        await assertVoucherStatus(voucherA, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherB, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherC, zep(90), zep(72), zep(18))
        await assertVoucherStatus(voucherD, zep(180), zep(180), zep(0))

        // Challenge 5%
        const receipt_5 = await vouching.challenge(id, pct(5), 'challenge 5%', '0xa', { from: challenger })
        const challengeID_5 = receipt_5.logs[0].args.challengeID
        await assertTotalStatus(zep(360), zep(307.8), zep(52.2))
        await assertVoucherStatus(voucherA, zep(45), zep(34.2), zep(10.8))
        await assertVoucherStatus(voucherB, zep(45), zep(34.2), zep(10.8))
        await assertVoucherStatus(voucherC, zep(90), zep(68.4), zep(21.6))
        await assertVoucherStatus(voucherD, zep(180), zep(171), zep(9))

        // Reject Challenge 5%
        await vouching.reject(challengeID_5, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_5)
        await assertTotalStatus(zep(376.2), zep(340.2), zep(36))
        await assertVoucherStatus(voucherA, zep(46.8), zep(37.8), zep(9))
        await assertVoucherStatus(voucherB, zep(46.8), zep(37.8), zep(9))
        await assertVoucherStatus(voucherC, zep(93.6), zep(75.6), zep(18))
        await assertVoucherStatus(voucherD, zep(189), zep(189), zep(0))

        // Challenge 50%
        const receipt_50 = await vouching.challenge(id, pct(50), 'challenge 50%', '0xa', { from: challenger })
        const challengeID_50 = receipt_50.logs[0].args.challengeID
        await assertTotalStatus(zep(376.2), zep(170.1), zep(206.1))
        await assertVoucherStatus(voucherA, zep(46.8), zep(18.9), zep(27.9))
        await assertVoucherStatus(voucherB, zep(46.8), zep(18.9), zep(27.9))
        await assertVoucherStatus(voucherC, zep(93.6), zep(37.8), zep(55.8))
        await assertVoucherStatus(voucherD, zep(189), zep(94.5), zep(94.5))

        // Challenge 90%
        const receipt_90 = await vouching.challenge(id, pct(90), 'challenge 90%', '0xa', { from: challenger })
        const challengeID_90 = receipt_90.logs[0].args.challengeID
        await assertTotalStatus(zep(376.2), zep(17.01), zep(359.19))
        await assertVoucherStatus(voucherA, zep(46.8), zep(1.89), zep(44.91))
        await assertVoucherStatus(voucherB, zep(46.8), zep(1.89), zep(44.91))
        await assertVoucherStatus(voucherC, zep(93.6), zep(3.78), zep(89.82))
        await assertVoucherStatus(voucherD, zep(189), zep(9.45), zep(179.55))

        // Accept Challenge 90%
        await vouching.accept(challengeID_90, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_90)
        await assertTotalStatus(zep(223.11), zep(17.01), zep(206.1))
        await assertVoucherStatus(voucherA, zep(29.79), zep(1.89), zep(27.9))
        await assertVoucherStatus(voucherB, zep(29.79), zep(1.89), zep(27.9))
        await assertVoucherStatus(voucherC, zep(59.58), zep(3.78), zep(55.8))
        await assertVoucherStatus(voucherD, zep(103.95), zep(9.45), zep(94.5))
      })
    })

    context('challenges + vouching v2', function () {
      const [voucherA, voucherB, voucherC, voucherD] = [anyone, voucher, entryOwner, challenger]
      const [vouchedAmountA, vouchedAmountB, vouchedAmountC] = [zep(50), zep(50), zep(100)]

      beforeEach('register entry and vouch tokens', async function () {
        vouching = this.vouching
        const receipt = await vouching.register(this.entryAddress, MINIMUM_STAKE, METADATA_URI, METADATA_HASH, { from: entryOwner })
        id = receipt.logs[0].args.id

        await vouching.vouch(id, vouchedAmountA, { from: voucherA })
        await vouching.vouch(id, vouchedAmountB, { from: voucherB })
        await vouching.vouch(id, vouchedAmountC, { from: voucherC })
      })

      it('should hold given scenario', async function () {
        await assertTotalStatus(zep(200), zep(200), zep(0))
        await assertVoucherStatus(voucherA, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherB, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherC, zep(100), zep(100), zep(0))

        // Challenge 10%
        const receipt_10 = await vouching.challenge(id, pct(10), 'challenge 10%', '0xa', { from: challenger })
        const challengeID_10 = receipt_10.logs[0].args.challengeID
        await assertTotalStatus(zep(200), zep(180), zep(20))
        await assertVoucherStatus(voucherA, zep(50), zep(45), zep(5))
        await assertVoucherStatus(voucherB, zep(50), zep(45), zep(5))
        await assertVoucherStatus(voucherC, zep(100), zep(90), zep(10))

        // Accept Challenge 10%
        await vouching.accept(challengeID_10, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_10)
        await assertTotalStatus(zep(180), zep(180), zep(0))
        await assertVoucherStatus(voucherA, zep(45), zep(45), zep(0))
        await assertVoucherStatus(voucherB, zep(45), zep(45), zep(0))
        await assertVoucherStatus(voucherC, zep(90), zep(90), zep(0))

        // Challenge 20%
        const receipt_20 = await vouching.challenge(id, pct(20), 'challenge 20%', '0xa', { from: challenger })
        const challengeID_20 = receipt_20.logs[0].args.challengeID
        await assertTotalStatus(zep(180), zep(144), zep(36))
        await assertVoucherStatus(voucherA, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherB, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherC, zep(90), zep(72), zep(18))

        // Challenge 5%
        const receipt_5 = await vouching.challenge(id, pct(5), 'challenge 5%', '0xa', { from: challenger })
        const challengeID_5 = receipt_5.logs[0].args.challengeID
        await assertTotalStatus(zep(180), zep(136.8), zep(43.2))
        await assertVoucherStatus(voucherA, zep(45), zep(34.2), zep(10.8))
        await assertVoucherStatus(voucherB, zep(45), zep(34.2), zep(10.8))
        await assertVoucherStatus(voucherC, zep(90), zep(68.4), zep(21.6))

        // Vouch D 180
        await vouching.vouch(id, zep(180), { from: voucherD })
        await assertTotalStatus(zep(360), zep(316.8), zep(43.2))
        await assertVoucherStatus(voucherA, zep(45), zep(34.2), zep(10.8))
        await assertVoucherStatus(voucherB, zep(45), zep(34.2), zep(10.8))
        await assertVoucherStatus(voucherC, zep(90), zep(68.4), zep(21.6))
        await assertVoucherStatus(voucherD, zep(180), zep(180), zep(0))

        // Reject Challenge 5%
        await vouching.reject(challengeID_5, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_5)
        await assertTotalStatus(zep(367.2), zep(331.2), zep(36))
        await assertVoucherStatus(voucherA, zep(46.8), zep(37.8), zep(9))
        await assertVoucherStatus(voucherB, zep(46.8), zep(37.8), zep(9))
        await assertVoucherStatus(voucherC, zep(93.6), zep(75.6), zep(18))
        await assertVoucherStatus(voucherD, zep(180), zep(180), zep(0))

        // Challenge 50%
        const receipt_50 = await vouching.challenge(id, pct(50), 'challenge 50%', '0xa', { from: challenger })
        const challengeID_50 = receipt_50.logs[0].args.challengeID
        await assertTotalStatus(zep(367.2), zep(165.6), zep(201.6))
        await assertVoucherStatus(voucherA, zep(46.8), zep(18.9), zep(27.9))
        await assertVoucherStatus(voucherB, zep(46.8), zep(18.9), zep(27.9))
        await assertVoucherStatus(voucherC, zep(93.6), zep(37.8), zep(55.8))
        await assertVoucherStatus(voucherD, zep(180), zep(90), zep(90))

        // Challenge 90%
        const receipt_90 = await vouching.challenge(id, pct(90), 'challenge 90%', '0xa', { from: challenger })
        const challengeID_90 = receipt_90.logs[0].args.challengeID
        await assertTotalStatus(zep(367.2), zep(16.56), zep(350.64))
        await assertVoucherStatus(voucherA, zep(46.8), zep(1.89), zep(44.91))
        await assertVoucherStatus(voucherB, zep(46.8), zep(1.89), zep(44.91))
        await assertVoucherStatus(voucherC, zep(93.6), zep(3.78), zep(89.82))
        await assertVoucherStatus(voucherD, zep(180), zep(9), zep(171))

        // Accept Challenge 90%
        await vouching.accept(challengeID_90, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_90)
        await assertTotalStatus(zep(218.16), zep(16.56), zep(201.6))
        await assertVoucherStatus(voucherA, zep(29.79), zep(1.89), zep(27.9))
        await assertVoucherStatus(voucherB, zep(29.79), zep(1.89), zep(27.9))
        await assertVoucherStatus(voucherC, zep(59.58), zep(3.78), zep(55.8))
        await assertVoucherStatus(voucherD, zep(99), zep(9), zep(90))
      })
    })

    context('challenges + unvouching v1', function () {
      const [voucherA, voucherB, voucherC] = [anyone, voucher, entryOwner]
      const [vouchedAmountA, vouchedAmountB, vouchedAmountC] = [zep(50), zep(50), zep(100)]

      beforeEach('register entry and vouch tokens', async function () {
        vouching = this.vouching
        const receipt = await vouching.register(this.entryAddress, MINIMUM_STAKE, METADATA_URI, METADATA_HASH, { from: entryOwner })
        id = receipt.logs[0].args.id

        await vouching.vouch(id, vouchedAmountA, { from: voucherA })
        await vouching.vouch(id, vouchedAmountB, { from: voucherB })
        await vouching.vouch(id, vouchedAmountC, { from: voucherC })
      })

      it('should hold given scenario', async function () {
        await assertTotalStatus(zep(200), zep(200), zep(0))
        await assertVoucherStatus(voucherA, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherB, zep(50), zep(50), zep(0))
        await assertVoucherStatus(voucherC, zep(100), zep(100), zep(0))

        // Challenge 10%
        const receipt_10 = await vouching.challenge(id, pct(10), 'challenge 10%', '0xa', { from: challenger })
        const challengeID_10 = receipt_10.logs[0].args.challengeID
        await assertTotalStatus(zep(200), zep(180), zep(20))
        await assertVoucherStatus(voucherA, zep(50), zep(45), zep(5))
        await assertVoucherStatus(voucherB, zep(50), zep(45), zep(5))
        await assertVoucherStatus(voucherC, zep(100), zep(90), zep(10))

        // Accept Challenge 10%
        await vouching.accept(challengeID_10, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_10)
        await assertTotalStatus(zep(180), zep(180), zep(0))
        await assertVoucherStatus(voucherA, zep(45), zep(45), zep(0))
        await assertVoucherStatus(voucherB, zep(45), zep(45), zep(0))
        await assertVoucherStatus(voucherC, zep(90), zep(90), zep(0))

        // Challenge 20%
        const receipt_20 = await vouching.challenge(id, pct(20), 'challenge 20%', '0xa', { from: challenger })
        const challengeID_20 = receipt_20.logs[0].args.challengeID
        await assertTotalStatus(zep(180), zep(144), zep(36))
        await assertVoucherStatus(voucherA, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherB, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherC, zep(90), zep(72), zep(18))

        // Unvouch B 25
        await vouching.unvouch(id, zep(25), { from: voucherB })
        await assertTotalStatus(zep(155), zep(119), zep(36))
        await assertVoucherStatus(voucherA, zep(45), zep(36), zep(9))
        await assertVoucherStatus(voucherB, zep(20), zep(11), zep(9))
        await assertVoucherStatus(voucherC, zep(90), zep(72), zep(18))

        // Challenge 5%
        const receipt_5 = await vouching.challenge(id, pct(5), 'challenge 5%', '0xa', { from: challenger })
        const challengeID_5 = receipt_5.logs[0].args.challengeID
        await assertTotalStatus(zep(155), zep(113.05), zep(41.95))
        await assertVoucherStatus(voucherA, zep(45), zep(34.2), zep(10.8))
        await assertVoucherStatus(voucherB, zep(20), zep(10.45), zep(9.55))
        await assertVoucherStatus(voucherC, zep(90), zep(68.4), zep(21.6))

        // Reject Challenge 5%
        await vouching.reject(challengeID_5, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_5)
        await assertTotalStatus(zep(160.95), zep(124.95), zep(36))
        await assertVoucherStatus(voucherA, zep(46.8), zep(37.8), zep(9))
        await assertVoucherStatus(voucherB, zep(20.55), zep(11.55), zep(9))
        await assertVoucherStatus(voucherC, zep(93.6), zep(75.6), zep(18))

        // Challenge 50%
        const receipt_50 = await vouching.challenge(id, pct(50), 'challenge 50%', '0xa', { from: challenger })
        const challengeID_50 = receipt_50.logs[0].args.challengeID
        await assertTotalStatus(zep(160.95), zep(62.475), zep(98.475))
        await assertVoucherStatus(voucherA, zep(46.8), zep(18.9), zep(27.9))
        await assertVoucherStatus(voucherB, zep(20.55), zep(5.775), zep(14.775))
        await assertVoucherStatus(voucherC, zep(93.6), zep(37.8), zep(55.8))

        // Challenge 90%
        const receipt_90 = await vouching.challenge(id, pct(90), 'challenge 90%', '0xa', { from: challenger })
        const challengeID_90 = receipt_90.logs[0].args.challengeID
        await assertTotalStatus(zep(160.95), zep(6.2475), zep(154.7025))
        await assertVoucherStatus(voucherA, zep(46.8), zep(1.89), zep(44.91))
        await assertVoucherStatus(voucherB, zep(20.55), zep(0.5775), zep(19.9725))
        await assertVoucherStatus(voucherC, zep(93.6), zep(3.78), zep(89.82))

        // Accept Challenge 90%
        await vouching.accept(challengeID_90, { from: entryOwner })
        await timeTravel(APPEAL_WINDOW_SECONDS + 1)
        await vouching.confirm(challengeID_90)
        await assertTotalStatus(zep(104.7225), zep(6.2475), zep(98.475))
        await assertVoucherStatus(voucherA, zep(29.79), zep(1.89), zep(27.9))
        await assertVoucherStatus(voucherB, zep(15.3525), zep(0.5775), zep(14.775))
        await assertVoucherStatus(voucherC, zep(59.58), zep(3.78), zep(55.8))
      })
    })

    const assertTotalStatus = async (expectedVouched, expectedAvailable, expectedBlocked) => {
      const totalVouched = await vouching.totalVouched(id)
      totalVouched.should.be.bignumber.eq(expectedVouched)

      const totalBlocked = await vouching.totalBlocked(id)
      totalBlocked.should.be.bignumber.eq(expectedBlocked)

      const totalAvailable = await vouching.totalAvailable(id)
      totalAvailable.should.be.bignumber.eq(expectedAvailable)
    }

    const assertVoucherStatus = async (voucher, expectedVouched, expectedAvailable, expectedBlocked) => {
      const vouched = await vouching.vouched(id, voucher)
      vouched.should.be.bignumber.eq(expectedVouched)

      const blocked = await vouching.blocked(id, voucher)
      blocked.should.be.bignumber.eq(expectedBlocked)

      const available = await vouching.available(id, voucher)
      available.should.be.bignumber.eq(expectedAvailable)
    }
  })
})
