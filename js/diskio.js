// XXX -- its possible for a job to be in "active" state and never
// time out... need to set a timeout for each job, because I may make
// some kind of error, or possibly some bug with chrome implementation


function DiskIOJob(opts) {
    this.client = opts.client
    this.jobId = opts.jobId
    this.opts = opts

    jstorrent.Item.apply(this, arguments)

    this.set('type',opts.type)
    this.set('torrent',opts.torrent)
    this.set('fileNum',opts.fileNum)
    this.set('fileOffset',opts.fileOffset)
    this.set('size',opts.size)
    this.set('jobId',opts.jobId)
    this.set('jobGroup',opts.jobgroup)
    this.set('state','idle')
}
jstorrent.DiskIOJob = DiskIOJob

DiskIOJob.randomFailure = 0 // test random failures with probability
DiskIOJob.jobTimeoutInterval = 10000 // too low?

DiskIOJob.prototype = {
    get_key: function() {
        return this.jobId
    }
}

for (var method in jstorrent.Item.prototype) {
    jstorrent.DiskIOJob.prototype[method] = jstorrent.Item.prototype[method]
}

function DiskIO(opts) {
    this.client = opts.client
    this.filesystem = opts.filesystem

    this.jobIdCounter = 0
    this.jobGroupCounter = 0
    this.jobGroupCallbacks = {}
    this.jobsLeftInGroup = {}

    this.diskActive = false

    jstorrent.Collection.apply(this, arguments)
}
jstorrent.DiskIO = DiskIO

DiskIO.prototype = {
    cancelTorrentJobs: function(torrent) {
        this.each( _.bind(function(job) {
            if (job.opts.piece.torrent == torrent) {
                if (job.get('state') == 'idle') {
                    console.log('cancel job',job._attributes)
                    this.remove(job)
                }
            }
        },this))
    },
    readPiece: function(piece, offset, size, callback) {
        // reads a bunch of piece data from all the spanning files
        var filesSpanInfo = piece.getSpanningFilesInfo(offset, size)

        //if (piece.num == 10) { debugger }
        var job,fileSpanInfo
        var jobs = []
        var jobGroup = this.jobGroupCounter++
        this.jobsLeftInGroup[jobGroup] = 0
        this.jobGroupCallbacks[jobGroup] = {data:[],callback:callback}
        
        for (var i=0; i<filesSpanInfo.length; i++) {
            fileSpanInfo = filesSpanInfo[i]
            job = new jstorrent.DiskIOJob( {type: 'read',
                                            piece: piece,
                                            jobId: this.jobIdCounter++,
                                            torrent: piece.torrent.hashhexlower,
                                            fileNum: fileSpanInfo.fileNum,
                                            fileOffset: fileSpanInfo.fileOffset,
                                            size: fileSpanInfo.size,
                                            jobGroup: jobGroup} )
            this.add(job)
            this.jobsLeftInGroup[jobGroup]++
        }

        this.thinkNewState()
    },
    thinkNewState: function() {
        if (! this.diskActive) {
            // pop off a job and do it!
            if (this.items.length > 0) {
                this.diskActive = true
                this.doJob()
            }
        }
    },
    jobDone: function(job, evt) {
        if (job.get('state') == 'error') {
            console.warn('jobDone triggered, but was in error state',job)
            return
        }
        job.set('state','idle')
        //console.log(job.opts.jobId,'jobDone')
        this.diskActive = false
        this.remove(job)
        this.jobsLeftInGroup[job.opts.jobGroup]--

        if (this.jobsLeftInGroup[job.opts.jobGroup] == 0) {
            delete this.jobsLeftInGroup[job.opts.jobGroup]
            var callback = this.jobGroupCallbacks[job.opts.jobGroup].callback
            var data = this.jobGroupCallbacks[job.opts.jobGroup].data
            delete this.jobGroupCallbacks[job.opts.jobGroup]
            callback({piece:job.opts.piece, data:data})
        }
        this.thinkNewState()
    },
    jobError: function(job, evt) {
        // when a job errors, cancel the whole job group with an error

        job.set('state','error')
        console.error('joberror',job.opts.jobId,evt)
        this.diskActive = false
        this.remove(job)
        this.opts.disk.client.error('fatal disk job error')
        var callback = this.jobGroupCallbacks[job.opts.jobGroup].callback
        var data = this.jobGroupCallbacks[job.opts.jobGroup].data
        delete this.jobGroupCallbacks[job.opts.jobGroup]
        callback({error:evt, data:data})
        this.thinkNewState()
    },
    doJobReadyToRead: function(entry, job) {
        var _this = this
        entry.file( function(file) {
            if (! file) {
                _this.jobError(job, 'error getting file')
            } else {
                var reader = new FileReader
                reader.onload = function(evt) {
                    // XXX is data.push sufficient to keep things in order?
                    _this.jobGroupCallbacks[job.opts.jobGroup].data.push(evt.target.result)
                    _this.jobDone(job, evt)
                }
                reader.onerror = function(evt) {
                    _this.jobError(job, 'error reading file')
                }
                var blobSlice = file.slice(job.opts.fileOffset, job.opts.fileOffset + job.opts.size)
                // console.log('blobslice...read',blobSlice)
                reader.readAsArrayBuffer(blobSlice)
            }
        })
    },
    doJobReadyToWrite: function(entry, job) {
        //console.log(job.opts.jobId, 'doJobReadyToWrite')
        var _this = this

        entry.createWriter( function(writer) {
            writer.onwrite = function(evt) {
                //console.log(job.opts.jobId, 'offset',job.opts.fileOffset,'diskio wrote',evt.loaded)
                _this.jobDone(job, evt)
            }
            writer.onerror = function(evt) {
                _this.jobError(job, evt)
            }
            writer.seek(job.opts.fileOffset)
            writer.write(new Blob([job.opts.data]))
        })
    },
    needToPad: function(job, entry, numZeroes, metaData) {
        //console.log(job.opts.jobId,'needToPad')
        // since .seek doesn't allow seeking past end of file, we pad
        // with arbitrary data (zeroes)
        var _this = this
        var writtenSoFar = 0
        var limitPerStep = 1048576 // only allow writing a certain number of zeros at a time

        function next() {
            console.assert(numZeroes)
            console.assert(metaData)
            console.assert(job)
            console.assert(entry)

            var curZeroes = Math.min(limitPerStep, (numZeroes - writtenSoFar))
            //console.log(job.opts.jobId,'needToPad.next',curZeroes,numZeroes)
            console.assert(curZeroes > 0)

            var buf = new Uint8Array(curZeroes)
            entry.createWriter( function(writer) {
                writer.onwrite = function(evt) {
                    //console.log('%cZERO PAD - diskio wrote','background:#0ff;color:#fff',evt.loaded,'/',evt.total)
                    if (writtenSoFar == numZeroes) {
                        _this.doJobReadyToWrite(entry, job)
                    } else {
                        next()
                    }
                }
                writer.onerror = function(evt) {
                    _this.jobError(job, evt)
                }
                writer.seek(metaData.size + writtenSoFar)
                writtenSoFar += curZeroes
                writer.write( new Blob([buf]) )
            })
        }
        next()
    },
    checkJobTimeout: function(job) {
        if (this.items.length > 0 &&
            this.get_at(0) == job &&
            job.get('state') == 'active') {
            console.error("DISKIO JOB DIDNT FINISH -- TIMEOUT. WTF", job.opts.jobId)
            this.jobError(job,'timeout')

            // jobDone may still get triggered! hmm...
        }
    },
    doJob: function() {
        // XXX -- need to use a timeout! when a job starts, it should
        // finish within a second! otherwise, there has been some kind
        // of unforeseen error...

        var _this = this
        var job = this.get_at(0)
        setTimeout( _.bind(this.checkJobTimeout, this, job), DiskIOJob.jobTimeoutInterval )
        //console.log(job.opts.jobId, 'doJob, group',job.opts.jobGroup, 'filenum',job.opts.fileNum,'fileoffset',job.opts.fileOffset)
        job.set('state','active')

        if (Math.random() < DiskIOJob.randomFailure) {
            this.jobError(job, 'random failure')
            return
        }

        var file = job.opts.piece.torrent.getFile(job.opts.fileNum)

        file.getEntry( function(entry){
            if (entry.isFile) {
                if (job.opts.type == 'write') {
                    entry.getMetadata( function(metaData) {
                        //if (job.opts.size == 4096) { debugger }
                        //console.log(job.opts.jobId, 'doJob.getMetadata')
                        if (job.opts.fileOffset <= metaData.size) {
                            _this.doJobReadyToWrite(entry, job)
                        } else {
                            var numZeroes = job.opts.fileOffset - metaData.size
                            _this.needToPad( job, entry, numZeroes, metaData )
                        }
                    })
                } else {
                    _this.doJobReadyToRead(entry, job)
                }
            } else {
                this.opts.disk.client.error('fatal disk i/o error')
                console.error('fatal diskio processing job')
            }
        })
    },
    writePiece: function(piece, callback) {
        // writes piece to disk

        var filesSpanInfo = piece.getSpanningFilesInfo()
        var job,fileSpanInfo
        var jobs = []
        var jobGroup = this.jobGroupCounter++
        this.jobsLeftInGroup[jobGroup] = 0
        this.jobGroupCallbacks[jobGroup] = {data:[],callback:callback}
        
        for (var i=0; i<filesSpanInfo.length; i++) {
            fileSpanInfo = filesSpanInfo[i]
            //console.log('writepiecefilespan',fileSpanInfo)

            var bufslice = new Uint8Array(piece.data, fileSpanInfo.pieceOffset, fileSpanInfo.size)



            if (fileSpanInfo.pieceOffset == 0 && fileSpanInfo.size == piece.data.byteLength) {
                // TODO -- more efficient if piece fully contained in this file (dont have to do this copy)
                var buftowrite = bufslice
            } else {
                var buftowrite = new Uint8Array(fileSpanInfo.size)
                buftowrite.set(bufslice, 0)
            }


            job = new jstorrent.DiskIOJob( {type: 'write',
                                            data: buftowrite.buffer,
                                            piece: piece,
                                            jobId: this.jobIdCounter++,
                                            torrent: piece.torrent.hashhexlower,
                                            fileNum: fileSpanInfo.fileNum,
                                            fileOffset: fileSpanInfo.fileOffset,
                                            size: fileSpanInfo.size,
                                            jobGroup: jobGroup} )
            this.add(job)
            this.jobsLeftInGroup[jobGroup]++
        }
        this.thinkNewState()
    }
}

for (var method in jstorrent.Collection.prototype) {
    jstorrent.DiskIO.prototype[method] = jstorrent.Collection.prototype[method]
}
