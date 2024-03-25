import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  sendAndConfirmRawTransaction,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { initializeKeypair, makeKeypairs } from '@solana-developers/helpers';
import base58 from 'bs58';
import assert from 'assert';
import dotenv from 'dotenv';
dotenv.config();

const createNonceAccount = async (
  payer: Keypair,
  nonceKeypair: Keypair,
  authority: PublicKey,
  connection: Connection,
) => {
  const tx = new Transaction().add(
    // create system account with the minimum amount needed for rent exemption.
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: nonceKeypair.publicKey,
      lamports: 0.0015 * LAMPORTS_PER_SOL,
      space: NONCE_ACCOUNT_LENGTH,
      programId: SystemProgram.programId,
    }),
    // initialize nonce with the created nonceKeypair's pubkey as the noncePubkey
    // also specify the authority of the nonce account
    SystemProgram.nonceInitialize({
      noncePubkey: nonceKeypair.publicKey,
      authorizedPubkey: authority,
    }),
  );

  // send the transaction
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, nonceKeypair]);
  console.log(
    'Creating Nonce TX:',
    `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899`,
  );

  // Fetching the nonce account
  const accountInfo = await connection.getAccountInfo(nonceKeypair.publicKey);
  return NonceAccount.fromAccountData(accountInfo!.data);
};

describe('transfer-hook', () => {
  const connection = new Connection('http://localhost:8899', 'confirmed');

  it('Creates a durable transaction and submits it', async () => {
    const payer = await initializeKeypair(connection, {
      airdropAmount: 3 * LAMPORTS_PER_SOL,
      minimumBalance: 1 * LAMPORTS_PER_SOL,
    });

    const [nonceKeypair, recipient] = makeKeypairs(2);

    // Create the Nonce Account
    const nonceAccount = await createNonceAccount(payer, nonceKeypair, payer.publicKey, connection);

    // Assemble the durable transaction
    const durableTx = new Transaction();
    durableTx.feePayer = payer.publicKey;

    // use the nonceAccount's stored nonce as the recentBlockhash
    durableTx.recentBlockhash = nonceAccount.nonce;

    // make a nonce advance instruction
    durableTx.add(
      SystemProgram.nonceAdvance({
        authorizedPubkey: payer.publicKey,
        noncePubkey: nonceKeypair.publicKey,
      }),
    );

    // Add the transfer sols instruction
    durableTx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      }),
    );

    // sign the tx with the nonce authority's keypair
    durableTx.sign(payer);

    // once you have the signed tx, you can serialize it and store it
    // in a database or in a file, or send it to another device.
    const serializedTx = base58.encode(durableTx.serialize({ requireAllSignatures: false }));

    // You can submit it at a later point, without the tx having a mortality
    const tx = base58.decode(serializedTx);

    const sig = await sendAndConfirmRawTransaction(connection, tx as Buffer, {
      skipPreflight: true,
    });

    console.log(
      'Transaction Signature:',
      `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899`,
    );
  });

  it('Fails if the nonce has advanced', async () => {
    const payer = await initializeKeypair(connection, {
      airdropAmount: 3 * LAMPORTS_PER_SOL,
      minimumBalance: 1 * LAMPORTS_PER_SOL,
    });

    const [nonceKeypair, nonceAuthority, recipient] = makeKeypairs(3);

    // Create the Nonce Account
    const nonceAccount = await createNonceAccount(payer, nonceKeypair, nonceAuthority.publicKey, connection);

    const durableTx = new Transaction();
    durableTx.feePayer = payer.publicKey;

    // use the nonceAccount's stored nonce as the recentBlockhash
    durableTx.recentBlockhash = nonceAccount.nonce;

    // make a nonce advance instruction
    durableTx.add(
      SystemProgram.nonceAdvance({
        authorizedPubkey: nonceAuthority.publicKey,
        noncePubkey: nonceKeypair.publicKey,
      }),
    );

    // Transfer 50 sols instruction
    // This will fail because the account doesn't have enough balance
    durableTx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      }),
    );

    // sign the tx with both the payer and nonce authority's keypair
    durableTx.sign(payer, nonceAuthority);

    // once you have the signed tx, you can serialize it and store it in a database, or send it to another device
    const serializedTx = base58.encode(durableTx.serialize({ requireAllSignatures: false }));

    // Now we will advance the nonce
    const nonceAdvanceSig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.nonceAdvance({
          noncePubkey: nonceKeypair.publicKey,
          authorizedPubkey: nonceAuthority.publicKey,
        }),
      ),
      [payer, nonceAuthority],
    );

    console.log(
      'Nonce Advance Signature:',
      `https://explorer.solana.com/tx/${nonceAdvanceSig}?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899`,
    );

    const tx = base58.decode(serializedTx);

    // assert the promise to throw an error
    await assert.rejects(sendAndConfirmRawTransaction(connection, tx as Buffer));
  });

  it('Advances the nonce account even if the transaction fails', async () => {
    const TRANSFER_AMOUNT = 50;
    const payer = await initializeKeypair(connection, {
      airdropAmount: 3 * LAMPORTS_PER_SOL,
      minimumBalance: 1 * LAMPORTS_PER_SOL,
    });

    const [nonceKeypair, nonceAuthority, recipient] = makeKeypairs(3);

    // Create the Nonce Account
    const nonceAccount = await createNonceAccount(payer, nonceKeypair, nonceAuthority.publicKey, connection);
    const nonceBeforeAdvancing = nonceAccount.nonce;

    console.log('Nonce Before Advancing:', nonceBeforeAdvancing);

    // Assemble a durable transaction that will fail

    const balance = await connection.getBalance(payer.publicKey);

    // making sure that we don't have 50 SOL in the account
    assert(
      balance < TRANSFER_AMOUNT * LAMPORTS_PER_SOL,
      `Too much balance, try to change the transfer amount constant 'TRANSFER_AMOUNT' at the top of the function to be more than ${
        balance / LAMPORTS_PER_SOL
      }`,
    );

    const durableTx = new Transaction();
    durableTx.feePayer = payer.publicKey;

    // use the nonceAccount's stored nonce as the recentBlockhash
    durableTx.recentBlockhash = nonceAccount.nonce;

    // make a nonce advance instruction
    durableTx.add(
      SystemProgram.nonceAdvance({
        authorizedPubkey: nonceAuthority.publicKey,
        noncePubkey: nonceKeypair.publicKey,
      }),
    );

    // Transfer 50 sols instruction
    // This will fail because the account doesn't have enough balance
    durableTx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: TRANSFER_AMOUNT * LAMPORTS_PER_SOL,
      }),
    );

    // sign the tx with both the payer and nonce authority's keypair
    durableTx.sign(payer, nonceAuthority);

    // once you have the signed tx, you can serialize it and store it in a database, or send it to another device
    const serializedTx = base58.encode(durableTx.serialize({ requireAllSignatures: false }));

    const tx = base58.decode(serializedTx);

    // assert the promise to throw an error
    await assert.rejects(
      sendAndConfirmRawTransaction(connection, tx as Buffer, {
        skipPreflight: true,
      }),
    );

    const nonceAccountAfterAdvancing = await connection.getAccountInfo(nonceKeypair.publicKey);
    const nonceAfterAdvancing = NonceAccount.fromAccountData(nonceAccountAfterAdvancing!.data).nonce;

    // We can see that even though the transitions fails, the nonce has advanced
    assert.notEqual(nonceBeforeAdvancing, nonceAfterAdvancing);
  });

  it('The nonce account will not advance if the transaction fails because the nonce auth did not sign the transaction', async () => {
    const payer = await initializeKeypair(connection, {
      airdropAmount: 3 * LAMPORTS_PER_SOL,
      minimumBalance: 1 * LAMPORTS_PER_SOL,
    });

    const [nonceKeypair, nonceAuthority, recipient] = makeKeypairs(3);

    // Create the Nonce Account
    const nonceAccount = await createNonceAccount(payer, nonceKeypair, nonceAuthority.publicKey, connection);
    const nonceBeforeAdvancing = nonceAccount.nonce;

    console.log('Nonce before submitting:', nonceBeforeAdvancing);

    // Assemble a durable transaction that will fail

    const durableTx = new Transaction();
    durableTx.feePayer = payer.publicKey;

    // use the nonceAccount's stored nonce as the recentBlockhash
    durableTx.recentBlockhash = nonceAccount.nonce;

    // make a nonce advance instruction
    durableTx.add(
      SystemProgram.nonceAdvance({
        authorizedPubkey: nonceAuthority.publicKey,
        noncePubkey: nonceKeypair.publicKey,
      }),
    );

    durableTx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      }),
    );

    // sign the tx with the payer keypair
    durableTx.sign(payer);

    // once you have the signed tx, you can serialize it and store it in a database, or send it to another device
    const serializedTx = base58.encode(durableTx.serialize({ requireAllSignatures: false }));

    const tx = base58.decode(serializedTx);

    // assert the promise to throw an error
    await assert.rejects(
      sendAndConfirmRawTransaction(connection, tx as Buffer, {
        skipPreflight: true,
      }),
    );

    const nonceAccountAfterAdvancing = await connection.getAccountInfo(nonceKeypair.publicKey);
    const nonceAfterAdvancing = NonceAccount.fromAccountData(nonceAccountAfterAdvancing!.data).nonce;

    // We can see that the nonce did not advanced, because the error was in the nonce advance instruction
    assert.equal(nonceBeforeAdvancing, nonceAfterAdvancing);
  });

  // If the transaction fails because the nonce advance instruction fails, the nonce account will not advance
  // so if in the future the nonce advanced get fixed (maybe by chaning the nonce-auth to the users wallet) the trannsaction will be valid
  // will be valid and it could be submitted
  it('Submits after changing the nonce auth to an already signed address', async () => {
    const payer = await initializeKeypair(connection, {
      airdropAmount: 3 * LAMPORTS_PER_SOL,
      minimumBalance: 1 * LAMPORTS_PER_SOL,
    });

    const [nonceKeypair, nonceAuthority, recipient] = makeKeypairs(3);

    // Create the Nonce Account
    const nonceAccount = await createNonceAccount(payer, nonceKeypair, nonceAuthority.publicKey, connection);
    const nonceBeforeAdvancing = nonceAccount.nonce;

    console.log('Nonce before submitting:', nonceBeforeAdvancing);

    // Assemble a durable transaction that will fail

    const durableTx = new Transaction();
    durableTx.feePayer = payer.publicKey;

    // use the nonceAccount's stored nonce as the recentBlockhash
    durableTx.recentBlockhash = nonceAccount.nonce;

    // make a nonce advance instruction
    durableTx.add(
      SystemProgram.nonceAdvance({
        // The nonce auth is not the payer at this point of time, so the transaction will fail
        // But in the future we can change the nonce auth to be the payer and submit the transaction when ever we want
        authorizedPubkey: payer.publicKey,
        noncePubkey: nonceKeypair.publicKey,
      }),
    );

    durableTx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      }),
    );

    // sign the tx with the payer keypair
    durableTx.sign(payer);

    // once you have the signed tx, you can serialize it and store it in a database, or send it to another device
    const serializedTx = base58.encode(durableTx.serialize({ requireAllSignatures: false }));

    const tx = base58.decode(serializedTx);

    // assert the promise to throw an error
    // It will fail because the nonce auth is not the payer
    await assert.rejects(
      sendAndConfirmRawTransaction(connection, tx as Buffer, {
        skipPreflight: true,
      }),
    );

    const nonceAccountAfterAdvancing = await connection.getAccountInfo(nonceKeypair.publicKey);
    const nonceAfterAdvancing = NonceAccount.fromAccountData(nonceAccountAfterAdvancing!.data).nonce;

    // We can see that the nonce did not advanced, because the error was in the nonce advance instruction
    assert.equal(nonceBeforeAdvancing, nonceAfterAdvancing);

    // Now we can change the nonce auth to be the payer
    const nonceAuthSig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.nonceAuthorize({
          noncePubkey: nonceKeypair.publicKey,
          authorizedPubkey: nonceAuthority.publicKey,
          newAuthorizedPubkey: payer.publicKey,
        }),
      ),
      [payer, nonceAuthority],
    );

    console.log(
      'Nonce Auth Signature:',
      `https://explorer.solana.com/tx/${nonceAuthSig}?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899`,
    );

    // At any time in the future we can submit the transaction and it will go through
    const txSig = await sendAndConfirmRawTransaction(connection, tx as Buffer, {
      skipPreflight: true,
    });

    console.log(
      'Transaction Signature:',
      `https://explorer.solana.com/tx/${txSig}?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899`,
    );
  });
});
