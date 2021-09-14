const dotenv = require('dotenv');

dotenv.config();
const { validationResult } = require('express-validator');
const { Erc20, Wallet } = require('@wallfair.io/smart_contract_mock');
const { User } = require('@wallfair.io/wallfair-commons').models;
const authService = require('../services/auth-service');
const userService = require('../services/user-service');
const mailService = require('../services/mail-service');
const tradeService = require('../services/trade-service');
const { ErrorHandler } = require('../util/error-handler');
const { toPrettyBigDecimal } = require('../util/number-helper');

const WFAIR = new Erc20('WFAIR');

// Controller to sign up a new user
const login = async (req, res, next) => {
  // Validating User Inputs
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new ErrorHandler(422, 'Invalid phone number'));
  }

  // Defining User Inputs
  const { phone, ref } = req.body;

  try {
    const response = await authService.doLogin(phone, ref);
    res.status(201).json({
      phone,
      smsStatus: response.status,
      existing: !!response.existing,
    });
  } catch (err) {
    console.error(err);
    next(new ErrorHandler(422, err.message));
  }
};

const verfiySms = async (req, res, next) => {
  // Validating User Inputs
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new ErrorHandler(422, 'Invalid verification code'));
  }

  // Defining User Inputs
  const { phone, smsToken } = req.body;

  try {
    const user = await authService.verifyLogin(phone, smsToken);

    res.status(201).json({
      userId: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      walletAddress: user.walletAddress,
      session: await authService.generateJwt(user),
      confirmed: user.confirmed,
    });
  } catch (err) {
    next(new ErrorHandler(422, err.message));
  }
};

const bindWalletAddress = async (req, res, next) => {
  console.log('Binding wallet address', req.body);

  // retrieve wallet address
  const { walletAddress } = req.body;

  // ensure address is present
  if (!walletAddress) {
    return next(new ErrorHandler(422, 'WalletAddress expected, but was missing'));
  }

  try {
    // check if there is already a user with this wallet
    const walletUser = await User.findOne({ walletAddress });

    // if this address was already bound to another user, return 409 error
    if (walletUser && walletUser.id !== req.user.id) {
      return next(new ErrorHandler(409, 'This wallet is already bound to another user'));
    } if (!walletUser) {
      // retrieve user who made the request
      let user = await userService.getUserById(req.user.id);

      user.walletAddress = walletAddress;
      user = await userService.saveUser(user);
    } else {
      // do nothing if wallet exists and is already bound to the same user who made the request
    }

    res.status(201).json({
      userId: user.id,
      walletAddress,
    });
  } catch (err) {
    console.log(err);
    next(new ErrorHandler(422, err.message));
  }
};

const saveAdditionalInformation = async (req, res, next) => {
  // Validating User Inputs
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new ErrorHandler(422, errors[0]));
  }

  // Defining User Inputs
  const { email, name, username } = req.body;

  try {
    let user = await userService.getUserById(req.user.id);

    if (username) {
      const usernameUser = await User.findOne({ username });

      if (usernameUser !== null && !usernameUser._id.equals(user._id)) {
        return next(new ErrorHandler(409, 'Username is already used'));
      }

      user.username = username.replace(' ', '');
      user.name = name;
    }

    if (email) {
      const emailUser = await User.findOne({ email });

      if (emailUser !== null && !emailUser._id.equals(user._id)) {
        return next(new ErrorHandler(409, 'Email address is already used'));
      }

      user.email = email.replace(' ', '');

      await rewardRefUserIfNotConfirmed(user);
      await mailService.sendConfirmMail(user);
    }

    user = await userService.saveUser(user);

    res.status(201).json({
      userId: user.id,
      phone: user.phone,
      name: user.username,
      email: user.email,
    });
  } catch (err) {
    next(new ErrorHandler(422, err.message));
  }
};

const saveAcceptConditions = async (req, res, next) => {
  // Validating User Inputs
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new ErrorHandler(422, 'All conditions need to be accepted'));
  }

  try {
    let user = await userService.getUserById(req.user.id);
    const userConfirmedChanged = await rewardRefUserIfNotConfirmed(user);

    if (userConfirmedChanged) {
      user = await userService.saveUser(user);
    }

    res.status(201).json({
      confirmed: user.confirmed,
    });
  } catch (err) {
    next(new ErrorHandler(422, err.message));
  }
};

const rewardRefUserIfNotConfirmed = async (user) => {
  if (!user.confirmed) {
    await userService.rewardRefUser(user.ref);
    await userService.createUser(user);
    user.confirmed = true;
  }

  return user.confirmed;
};

// Receive all users in leaderboard
const getLeaderboard = async (req, res) => {
  const limit = +req.params.limit;
  const skip = +req.params.skip;

  const users = await User.find({ username: { $exists: true } })
    .select({ username: 1, amountWon: 1 })
    .sort({ amountWon: -1 })
    .limit(limit)
    .skip(skip)
    .exec();

  const total = await User.countDocuments().exec();

  res.json({
    total,
    users,
    limit,
    skip,
  });
};

// Receive specific user information
const getUserInfo = async (req, res, next) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    const balance = await WFAIR.balanceOf(userId);
    const formattedBalance = toPrettyBigDecimal(balance);
    const { rank, toNextRank } = await userService.getRankByUserId(userId);

    res.status(200).json({
      userId: user.id,
      name: user.name,
      username: user.username,
      profilePicture: user.profilePicture,
      balance: formattedBalance,
      totalWin: userService.getTotalWin(balance).toString(),
      admin: user.admin,
      emailConfirmed: user.emailConfirmed,
      rank,
      toNextRank,
      amountWon: user.amountWon,
    });
  } catch (err) {
    next(new ErrorHandler(422, 'Account information loading failed'));
  }
};

// Receive specific user information
const getRefList = async (req, res, next) => {
  try {
    const refList = await userService.getRefByUserId(req.user.id);

    res.status(200).json({
      userId: req.user.id,
      refList,
    });
  } catch (err) {
    next(new ErrorHandler(422, 'Account information loading failed'));
  }
};

const getOpenBetsList = async (request, response, next) => {
  const { user } = request;

  try {
    if (user) {
      const trades = await tradeService.getActiveTradesByUserId(user.id);

      const openBets = [];

      for (const trade of trades) {
        openBets.push({
          betId: trade._id.betId.toString(),
          outcome: trade._id.outcomeIndex,
          investmentAmount: trade.totalInvestmentAmount,
          outcomeAmount: trade.totalOutcomeTokens,
        });
      }

      response.status(200).json({
        openBets,
      });
    } else {
      return next(new ErrorHandler(404, 'User not found'));
    }
  } catch (err) {
    console.error(err);
    next(new ErrorHandler(500, err.message));
  }
};

const getTransactions = async (req, res, next) => {
  const { user } = req;

  try {
    if (user) {
      const wallet = new Wallet(user.id);
      const trx = await wallet.getTransactions();

      res.status(200).json(trx);
    } else {
      return next(new ErrorHandler(404, 'User not found'));
    }
  } catch (err) {
    console.error(err);
    next(new ErrorHandler(500, err.message));
  }
};

const getAMMHistory = async (req, res, next) => {
  const { user } = req;

  try {
    if (user) {
      const wallet = new Wallet(user.id);
      const interactions = await wallet.getAMMInteractions();
      const transactions = [];

      for (const interaction of interactions) {
        const investmentAmount = toPrettyBigDecimal(BigInt(interaction.investmentamount) / WFAIR.ONE);
        const feeAmount = toPrettyBigDecimal(BigInt(interaction.feeamount) / WFAIR.ONE)
        const outcomeTokensBought = toPrettyBigDecimal(BigInt(interaction.outcometokensbought) / WFAIR.ONE)

        transactions.push({
          ...interaction,
          investmentAmount,
          feeAmount,
          outcomeTokensBought,
        });
      }

      res.status(200).json(transactions);
    } else {
      return next(new ErrorHandler(404, 'User not found'));
    }
  } catch (err) {
    console.error(err);
    next(new ErrorHandler(500, err.message));
  }
};

const confirmEmail = async (req, res, next) => {
  // Validating User Inputs
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(res.status(400).send(errors));
  }

  // Defining User Inputs
  const { code, userId } = req.query;

  const user = await userService.getUserById(userId);

  if (user.emailConfirmed) {
    return next(new ErrorHandler(403, 'The email has been already confirmed'));
  }

  if (user.emailCode === code) {
    user.emailConfirmed = true;
    await user.save();
    res.status(200).send({ status: 'OK' });
  } else {
    next(new ErrorHandler(422, 'The email code is invalid'));
  }
};

const resendConfirmEmail = async (req, res, next) => {
  try {
    const user = await userService.getUserById(req.user.id);
    await mailService.sendConfirmMail(user);
    res.status(200).send({ status: 'OK' });
  } catch (err) {
    next(new ErrorHandler(422, err.message));
  }
};

const updateUser = async (req, res, next) => {
  if (req.user.admin === false && req.params.userId !== req.user.id) {
    return next(new ErrorHandler(403, 'Action not allowed'));
  }

  try {
    await userService.updateUser(req.params.userId, req.body);
    res.status(200).send({ status: 'OK' });
  } catch (err) {
    next(new ErrorHandler(422, err.message));
  }
};

exports.login = login;
exports.verfiySms = verfiySms;
exports.bindWalletAddress = bindWalletAddress;
exports.saveAdditionalInformation = saveAdditionalInformation;
exports.saveAcceptConditions = saveAcceptConditions;
exports.getUserInfo = getUserInfo;
exports.getRefList = getRefList;
exports.getOpenBetsList = getOpenBetsList;
exports.getTransactions = getTransactions;
exports.getAMMHistory = getAMMHistory;
exports.confirmEmail = confirmEmail;
exports.resendConfirmEmail = resendConfirmEmail;
exports.updateUser = updateUser;
exports.getLeaderboard = getLeaderboard;
