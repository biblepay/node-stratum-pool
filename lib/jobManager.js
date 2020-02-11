var events = require('events');
var crypto = require('crypto');
var bignum = require('bignum');
var myjob = require('./pool.js');
var util = require('./util.js');
var blockTemplate = require('./blockTemplate.js');


//Unique extranonce per subscriber
var ExtraNonceCounter = function(configInstanceId){

    var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    var counter = instanceId << 27;

    this.next = function(){
        var extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };

    this.size = 4; //bytes
};

//Unique job per new block template
var JobCounter = function(){
    var counter = 0;

    this.next = function(){
        counter++;
        if (counter % 0xffff === 0)
            counter = 1;
        return this.cur();
    };

    this.cur = function () {
        return counter.toString(16);
    };
};

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
**/
var JobManager = module.exports = function JobManager(options) {


    //private members

    var _this = this;
    var jobCounter = new JobCounter();

    var shareMultiplier = algos[options.coin.algorithm].multiplier;

    //public members

    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
    this.extraNoncePlaceholder = new Buffer('f000000ff111111f', 'hex');
    this.extraNonce2Size = this.extraNoncePlaceholder.length - this.extraNonceCounter.size;

    this.currentJob;
    this.validJobs = {};

    var hashDigest = algos[options.coin.algorithm].hash(options.coin);

    var coinbaseHasher = (function () {
        switch (options.coin.algorithm) {
            case 'keccak':
            case 'fugue':
            case 'groestl':
                if (options.coin.normalHashing === true)
                    return util.sha256d;
                else
                    return util.sha256;
            default:
                return util.sha256d;
        }
    })();


    var blockHasher = (function () {
        switch (options.coin.algorithm) {
            case 'scrypt':
                if (options.coin.reward === 'POS') {
                    return function (d) {
                        return util.reverseBuffer(hashDigest.apply(this, arguments));
                    };
                }
            case 'scrypt-jane':
                if (options.coin.reward === 'POS') {
                    return function (d) {
                        return util.reverseBuffer(hashDigest.apply(this, arguments));
                    };
                }
            case 'scrypt-n':
                return function (d) {
                    return util.reverseBuffer(util.sha256d(d));
                };
            default:
                return function () {
                    return util.reverseBuffer(hashDigest.apply(this, arguments));
                };
        }
    })();

    this.updateCurrentJob = function (rpcData) {

        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            options.recipients
        );

        _this.currentJob = tmpBlockTemplate;

        _this.emit('updatedBlock', tmpBlockTemplate, true);

        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

    };

    //returns true if processed a new block
    this.processGBT = function (rpcData, needNewBlock) {

        /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
        block height is greater than the one we have */
        var sHex = rpcData.hex;
        var height = rpcData.height;
        var merkleroot = rpcData.merkleroot;
        var rbits = rpcData.bits;
        var rtarg = rpcData.target;
        var nTime = parseInt(rpcData.curtime, 10);
        var nPrevBlockTime = parseInt(rpcData.prevblocktime, 10);
        // console.log('created new block for clients %d with bits %s and targ %s ', height, rbits, rtarg);
        // version(4), hashPrevBlock(32), hashMerkleRoot(32), Time(4), Bits(4), Nonce(4)

        var isNewBlock = typeof (_this.currentJob) === 'undefined';

        if (!isNewBlock) {
            var containsRPCData = typeof (_this.currentJob.rpcData) === 'undefined';
            if (!containsRPCData) {
                // var myJobHeight = this.currentJob.rpcData.height;
                // Not a new block:
                return false;
            }
        }
        if (!isNewBlock && _this.currentJob.rpcData.merkleroot !== rpcData.merkleroot) {
            isNewBlock = true;
            //If new block is outdated/out-of-sync than return
            //if (rpcData.height < _this.currentJob.rpcData.height)
            //    return false;
        }

        if (!isNewBlock) return false;

        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            options.recipients
        );

        this.currentJob = tmpBlockTemplate;
        this.currentJob.rpcData = rpcData;

        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        return true;

    };


    //returns true if processed a new block
    this.processTemplate = function (rpcData) {

        /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
        block height is greater than the one we have */
        var isNewBlock = typeof (_this.currentJob) === 'undefined';
        if (!isNewBlock && _this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
            isNewBlock = true;

            //If new block is outdated/out-of-sync than return
            if (rpcData.height < _this.currentJob.rpcData.height)
                return false;
        }

        if (!isNewBlock) return false;


        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            options.recipients
        );

        this.currentJob = tmpBlockTemplate;
        this.currentJob.rpcData = rpcData;

        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        return true;
    };


    this.reversehex = function (sHex) {
        if (sHex.length != 64)
            return '00';
        var hexout = '';

        for (var i = sHex.length; i > 0; i = i - 2) {
            var myhex = sHex.substring(i - 2, i);
            hexout += myhex;
            //console.log('myhexout %s ', hexout);
        }
        return hexout;
    };

    this.processShare = function (jobId, previousDifficulty, difficulty, nTime, ipAddress,
     port, workerName, out_rx, rxData, out_rxroot, poolAddress, rxSeed, blockSolution, in_rxhash, rpcBlockHash) {

        var shareError = function (error) {
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return { error: error, result: null };
        };

        var submitTime = Date.now() / 1000 | 0;
        var job = this.validJobs[jobId];

        if (typeof job === 'undefined' || job.jobId != jobId) {
            console.log('****** job not found %s', jobId);
            return shareError([21, 'job not found']);
        }

        if (out_rx.length < 32) {
            console.log('incorrect randomx hash %s', out_rx);
            return shareError([32, 'incorrect randomx hash']);
        }


        if (false) {
            if (nTime.length !== 8) {
                console.log('incorrect ntime %s', nTime);
                return shareError([20, 'incorrect size of ntime']);
            }
        }

        // RandomX is going to generate the pool address here:

        var nJobTime = parseInt(job.rpcData.curtime, 10);
        var nPrevBlockTime = parseInt(job.rpcData.prevblocktime, 10);
        var nCurBlockTime = parseInt(job.rpcData.curtime, 10);

        if (nTime < nCurBlockTime - (60 * 7) || nTime > nCurBlockTime + 7200 || nTime == 0) {
            if (true) {
                console.log('ntime out of range nTime %d, rpctime %d, rxData %s', nTime, nCurBlockTime, rxData);
                return shareError([20, 'ntime out of range']);
            }
        }

        if (!job.registerSubmit(out_rx, out_rx, job.rpcData.curtime, 0)) {
            console.log('duplicate share rx %s, rxroot %s, time %d', out_rx, out_rxroot, job.rpcData.curtime);
            return shareError([22, 'duplicate share']);
        }

        var rx_hash_analyzed = this.reversehex(in_rxhash);
        if (rx_hash_analyzed != out_rx) {
            console.log('stale share rx_hash %s, [%s], out_rx %s, out_rxroot %s, rxData %s, solving for wrong height?', out_rx, rx_hash_analyzed, out_rx, out_rxroot, rxData);
            return shareError([47, 'stale share']);
        }

        var RX1 = util.uint256BufferFromHash(out_rx);
        //var RX2 = util.reverseBuffer(RX1);

        var headerBigNum = bignum.fromBuffer(RX1, { endian: 'little', size: 32 });
        var blockHashInvalid;

        var shareDiff = diff1 / headerBigNum.toNumber() * shareMultiplier;

        if (false)
            console.log('shareDiff %d, smultiplier %d, submitting RX %s with rxroot %s and rxdata %s and rxseed %s \n', shareDiff, shareMultiplier, out_rx, out_rxroot, rxData, rxSeed);

        var blockDiffAdjusted = job.difficulty * shareMultiplier;
        var blockSolved = 0;
        //Check if share is a block candidate (matched network difficulty)

        if (job.target.ge(headerBigNum)) {
            //job.serializeBlock(headerBuffer, coinbaseBuffer).toString('hex');
            console.log('***** WE SOLVED THE BLOCK at height %s [%s] ******!!! ', rxData, blockSolution);
            blockSolved = 1;
        }
        else 
        {
            blockSolved = 0;
            if (options.emitInvalidBlockHashes)
                blockHashInvalid = util.reverseBuffer(util.sha256d(headerBuffer)).toString('hex');

            //Check if share didn't reached the miner's difficulty)
            if (shareDiff / difficulty < 0.99) {
                //Check if share matched a previous difficulty from before a vardiff retarget
                if (previousDifficulty && shareDiff >= previousDifficulty) {
                    difficulty = previousDifficulty;
                }
                else {
                    console.log('Low difficulty share of %d', shareDiff);
                    return shareError([23, 'low difficulty share of ' + shareDiff]);
                }

            }
        }

        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.coinbasevalue,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: out_rx,
            blockHashInvalid: blockHashInvalid,
            blockSolveData: blockSolution,
            blockSolved: blockSolved,
            x11hash: rpcBlockHash,
            hasabn: 0,
            poolOptionsAddress: options.address
        }, out_rx);

        return { result: true, error: null, blockHash: RX1 };
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
