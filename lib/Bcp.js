"use strict";
/* -------------------------------------------------------------------
 * Require Statements << Keep in alphabetical order >>
 * ---------------------------------------------------------------- */

var Athena = require('odyssey').athena;
var ChildProcess = require('child_process');
var debug = require('neo-debug')('bcp:');
var FormatFile = require('./FormatFile');
var Fs = require('fs');
var ImportFile = require('./ImportFile');				
var mkdirp = require('mkdirp');
var Path = require('path');

/* =============================================================================
 * 
 * Bcp - Class for interacting with the bcp utility.
 * 
 * Documentation snippets in this file are from the Microsoft BCP Utility 
 * documentation found at: http://msdn.microsoft.com/en-us/library/ms162802.aspx
 * They are simply included for convenience. Refer to the MS documentation for 
 * more details.
 *  
 * ========================================================================== */

var HOME = process.env.HOME || process.env.USERPROFILE;
var TMP = Path.join(HOME, '.bcp');

var NUL = String.fromCharCode(0);

module.exports = Bcp;
Bcp.FormatFile = FormatFile;

function Bcp (options)
{
	this.exec = options.exec || 'bcp';
	this.timeout = options.timeout || 0;
	this.killSignal = options.killSignal || 'SIGTERM';
	
	/**
	 * The directory where format and data files will be stored for bulk operations. The current user must have access 
	 * to this directory. If it does not exist, Bcp will attempt to create it. Defaults to $HOME/.bcp
	 * @member {string}
	 */
	this.tmp = options.tmp || TMP;
	
	/**
	 * Is the name of the database in which the specified table or view resides. If not specified, this is the default 
	 * database for the user.
	 * @member {string}
	 */
	this.database = options.database;

	/**
	 * The schema to use. Defaults to "dbo".
	 * @type {string=dbo}
	 */
	this.schema = options.schema || 'dbo';

	/**
	 * -a packet_size
	 *
	 * Specifies the number of bytes, per network packet, sent to and from the server. A server configuration option
	 * can be set by using SQL Server Management Studio (or the sp_configure system stored procedure). However, the
	 * server configuration option can be overridden on an individual basis by using this option. packet_size can be
	 * from 4096 to 65535 bytes; the default is 4096.
	 *
	 * Increased packet size can enhance performance of bulk-copy operations. If a larger packet is requested but
	 * cannot be granted, the default is used. The performance statistics generated by the bcp utility show the packet
	 * size used.
	 * @member {number}
	 */
	this.packetSize = options.packetSize;

	/**
	 * -b batch_size
	 * 
	 * Specifies the number of rows per batch of imported data. Each batch is imported and logged as a separate 
	 * transaction that imports the whole batch before being committed. By default, all the rows in the data file are 
	 * imported as one batch. To distribute the rows among multiple batches, specify a batch_size that is smaller than 
	 * the number of rows in the data file. If the transaction for any batch fails, only insertions from the current 
	 * batch are rolled back. Batches already imported by committed transactions are unaffected by a later failure.
	 * 
	 * Do not use this option in conjunction with the -h"ROWS_PER_BATCH = bb" option.
	 * @member {number}
	 */
	this.batchSize = options.batchSize;

	/**
	 * If true, content will be UTF-16 encoded. If false, ASCII will be used. If you're sure none of your data will use 
	 * unicode, then setting this to false will improve performance and reduce network traffic. Default: true.
	 * 
	 * True sets the -w flag. False sets the -c flag.
	 * @member {boolean=true}
	 */
	this.unicode = 'unicode' in options ? !!options.unicode : true; // -w vs -c

	/**
	 * -C { ACP | OEM | RAW | code_page }
	 * 
	 * Specifies the code page of the data in the data file. code_page is relevant only if the data contains char, 
	 * varchar, or text columns with character values greater than 127 or less than 32.
	 * @member {string=OEM}
	 */
	this.codePage = options.codePage || null;

	/**
	 * -e err_file
	 * 
	 * Specifies the full path of an error file used to store any rows that the bcp utility cannot transfer from the 
	 * file to the database. Error messages from the bcp command go to the workstation of the user. If this option is 
	 * not used, an error file is not created.
	 * 
	 * If err_file begins with a hyphen (-) or a forward slash (/), do not include a space between -e and the err_file 
	 * value.
	 * @member {string}
	 */
	this.errorFile = options.errorFile;

	/**
	 * -E
	 * 
	 * Specifies that identity value or values in the imported data file are to be used for the identity column. If -E 
	 * is not given, the identity values for this column in the data file being imported are ignored, and SQL Server 
	 * automatically assigns unique values based on the seed and increment values specified during table creation.
	 * 
	 * If the data file does not contain values for the identity column in the table or view, use a format file to 
	 * specify that the identity column in the table or view should be skipped when importing data; SQL Server 
	 * automatically assigns unique values for the column. For more information, see DBCC CHECKIDENT (Transact-SQL).
	 * 
	 * The -E option has a special permissions requirement. For more information, see "Remarks" later in this topic.
	 * @member {boolean}
	 */
	this.useIdentity = !!options.useIdentity;

	/**
	 * -F first_row
	 * 
	 * Specifies the number of the first row to export from a table or import from a data file. This parameter requires 
	 * a value greater than (>) 0 but less than (<) or equal to (=) the total number rows. In the absence of this 
	 * parameter, the default is the first row of the file.
	 * 
	 * first_row can be a positive integer with a value up to 2^63-1. -F first_row is 1-based.
	 * @member {number}
	 */
	this.firstRow = options.firstRow;

	/**
	 * ORDER column[ASC | DESC] [,...n]
	 * 
	 * The sort order of the data in the data file. Bulk import performance is improved if the data being imported is 
	 * sorted according to the clustered index on the table, if any. If the data file is sorted in a different order, 
	 * that is other than the order of a clustered index key, or if there is no clustered index on the table, the ORDER 
	 * clause is ignored. The column names supplied must be valid column names in the destination table. By default, 
	 * bcp assumes the data file is unordered. For optimized bulk import, SQL Server also validates that the imported 
	 * data is sorted.
	 * @type {string}
	 */
	this.order = options.order;

	/**
	 * ROWS_PER_BATCH bb
	 * 
	 * Number of rows of data per batch (as bb). Used when -b is not specified, resulting in the entire data file being 
	 * sent to the server as a single transaction. The server optimizes the bulk load according to the value bb. By 
	 * default, ROWS_PER_BATCH is unknown.
	 * @member {number}
	 */
	this.rowsPerBatch = options.rowsPerBatch;

	/**
	 * KILOBYTES_PER_BATCH cc
	 * 
	 * Approximate number of kilobytes of data per batch (as cc). By default, KILOBYTES_PER_BATCH is unknown.
	 * @member {number}
	 */
	this.kbPerBatch = options.kbPerBatch;

	/**
	 * TABLOCK
	 * 
	 * Specifies that a bulk update table-level lock is acquired for the duration of the bulk load operation; otherwise, 
	 * a row-level lock is acquired. This hint significantly improves performance because holding a lock for the 
	 * duration of the bulk-copy operation reduces lock contention on the table. A table can be loaded concurrently by 
	 * multiple clients if the table has no indexes and TABLOCK is specified. By default, locking behavior is determined 
	 * by the table option table lock on bulk load.
	 * @member {boolean}
	 */
	this.tabLock = !!options.tabLock;

	/**
	 * CHECK_CONSTRAINTS
	 * 
	 * Specifies that all constraints on the target table or view must be checked during the bulk-import operation. 
	 * Without the CHECK_CONSTRAINTS hint, any CHECK and FOREIGN KEY constraints are ignored, and after the operation 
	 * the constraint on the table is marked as not-trusted.
	 * 
	 * > UNIQUE, PRIMARY KEY, and NOT NULL constraints are always enforced.
	 * 
	 * At some point, you will need to check the constraints on the entire table. If the table was nonempty before the 
	 * bulk import operation, the cost of revalidating the constraint may exceed the cost of applying CHECK constraints 
	 * to the incremental data. Therefore, we recommend that normally you enable constraint checking during an 
	 * incremental bulk import.
	 * 
	 * A situation in which you might want constraints disabled (the default behavior) is if the input data contains 
	 * rows that violate constraints. With CHECK constraints disabled, you can import the data and then use Transact-SQL 
	 * statements to remove data that is not valid.
	 * 
	 * > bcp now enforces data validation and data checks that might cause scripts to fail if they are executed on 
	 * invalid data in a data file.
	 * > The -m max_errors switch does not apply to constraint checking.
	 * @member {boolean}
	 */
	this.checkConstraints = !!options.checkConstraints;

	/**
	 * FIRE_TRIGGERS
	 * 
	 * Specified with the in argument, any insert triggers defined on the destination table will run during the 
	 * bulk-copy operation. If FIRE_TRIGGERS is not specified, no insert triggers will run. FIRE_TRIGGERS is ignored 
	 * for the out, queryout, and format arguments.
	 * @member {boolean}
	 */
	this.fireTriggers = !!options.fireTriggers;

	/**
	 * -i input_file
	 * 
	 * Specifies the name of a response file, containing the responses to the command prompt questions for each data 
	 * field when a bulk copy is being performed using interactive mode (-n, -c, -w, or -N not specified).
	 * 
	 * If input_file begins with a hyphen (-) or a forward slash (/), do not include a space between -i and the 
	 * input_file value.
	 * @member {string}
	 */
	this.inputFile = options.inputFile;

	/**
	 * -k
	 * 
	 * Specifies that empty columns should retain a null value during the operation, rather than have any default 
	 * values for the columns inserted. For more information, see Keep Nulls or Use Default Values During Bulk Import 
	 * (SQL Server).
	 * @member {boolean}
	 */
	this.keepNulls = !!options.keepNulls;

	/**
	 * -K application_intent
	 * 
	 * Declares the application workload type when connecting to a server. The only value that is possible is ReadOnly. 
	 * If -K is not specified, the bcp utility will not support connectivity to a secondary replica in an AlwaysOn 
	 * availability group. For more information, see Active Secondaries: Readable Secondary Replicas (AlwaysOn 
	 * Availability Groups).
	 * @member {boolean}
	 */
	this.readOnly = !!options.readOnly;

	/**
	 * -L last_row
	 * 
	 * Specifies the number of the last row to export from a table or import from a data file. This parameter requires 
	 * a value greater than (>) 0 but less than (<) or equal to (=) the number of the last row. In the absence of this 
	 * parameter, the default is the last row of the file.
	 * 
	 * last_row can be a positive integer with a value up to 2^63-1.
	 * @member {number}
	 */
	this.lastRow = options.lastRow;

	/**
	 * -m max_errors
	 * 
	 * Specifies the maximum number of syntax errors that can occur before the bcp operation is canceled. A syntax 
	 * error implies a data conversion error to the target data type. The max_errors total excludes any errors that can 
	 * be detected only at the server, such as constraint violations.
	 * 
	 * A row that cannot be copied by the bcp utility is ignored and is counted as one error. If this option is not 
	 * included, the default is 10.
	 * 
	 * > The -m option also does not apply to converting the money or bigint data types.
	 * @member {number}
	 */
	this.maxErrors = options.maxErrors;

	/**
	 * -P password
	 * 
	 * Specifies the password for the login ID. If this option is not used, the bcp command prompts for a password. If 
	 * this option is used at the end of the command prompt without a password, bcp uses the default password (NULL).
	 * 
	 * > Do not use a blank password. Use a strong password.
	 * 
	 * To mask your password, do not specify the -P option along with the -U option. Instead, after specifying bcp 
	 * along with the -U option and other switches (do not specify -P), press ENTER, and the command will prompt you 
	 * for a password. This method ensures that your password will be masked when it is entered.
	 * 
	 * If password begins with a hyphen (-) or a forward slash (/), do not add a space between -P and the password 
	 * value.
	 * @member {string}
	 */
	this.password = options.password;

	/**
	 * -q
	 * 
	 * Executes the SET QUOTED_IDENTIFIERS ON statement in the connection between the bcp utility and an instance of 
	 * SQL Server. Use this option to specify a database, owner, table, or view name that contains a space or a single 
	 * quotation mark. Enclose the entire three-part table or view name in quotation marks ("").
	 * 
	 * To specify a database name that contains a space or single quotation mark, you must use the –q option.
	 * 
	 * -q does not apply to values passed to -d.
	 * 
	 * For more information, see Remarks, later in this topic.
	 * @member {boolean}
	 */
	this.quotedIdentifiers = !!options.quotedIdentifiers;

	/**
	 * -r row_term
	 * 
	 * Specifies the row terminator. The default is \n (newline character). Use this parameter to override the default 
	 * row terminator. For more information, see Specify Field and Row Terminators (SQL Server).
	 * 
	 * If you specify the row terminator in hexadecimal notation in a bcp.exe command, the value will be truncated at 
	 * 0x00. For example, if you specify 0x410041, 0x41 will be used.
	 * 
	 * If row_term begins with a hyphen (-) or a forward slash (/), do not include a space between -r and the row_term 
	 * value.
	 * @member {string}
	 */
	this.rowTerminator = options.rowTerminator;

	/**
	 * -R
	 * 
	 * Specifies that currency, date, and time data is bulk copied into SQL Server using the regional format defined 
	 * for the locale setting of the client computer. By default, regional settings are ignored.
	 * @member {boolean}
	 */
	this.regional = !!options.regional;

	/**
	 * -S server_name[ \instance_name]
	 * 
	 * Specifies the instance of SQL Server to which to connect. If no server is specified, the bcp utility connects to 
	 * the default instance of SQL Server on the local computer. This option is required when a bcp command is run from 
	 * a remote computer on the network or a local named instance. To connect to the default instance of SQL Server on 
	 * a server, specify only server_name. To connect to a named instance of SQL Server, specify 
	 * server_name\instance_name.
	 * @member {string}
	 */
	this.server = options.server;

	/**
	 * -t field_term
	 * 
	 * Specifies the field terminator. The default is \t (tab character). Use this parameter to override the default 
	 * field terminator. For more information, see Specify Field and Row Terminators (SQL Server).
	 * 
	 * If you specify the field terminator in hexadecimal notation in a bcp.exe command, the value will be truncated at 
	 * 0x00. For example, if you specify 0x410041, 0x41 will be used.
	 * 
	 * If field_term begins with a hyphen (-) or a forward slash (/), do not include a space between -t and the 
	 * field_term value.
	 * @member {string}
	 */
	this.fieldTerminator = options.fieldTerminator;
	
	/**
	 * -T
	 * 
	 * Specifies that the bcp utility connects to SQL Server with a trusted connection using integrated security. 
	 * The security credentials of the network user, login_id, and password are not required. If –T is not specified, 
	 * you need to specify –U and –P to successfully log in.
	 * @member {boolean=false}
	 */
	this.trusted = !!options.trusted;

	/**
	 * -U login_id
	 * 
	 * Specifies the login ID used to connect to SQL Server.
	 * 
	 * > When the bcp utility is connecting to SQL Server with a trusted connection using integrated security, use the 
	 * -T option (trusted connection) instead of the user name and password combination.
	 * @member {string}
	 */
	this.user = options.user;
	
}

/* -------------------------------------------------------------------
 * Public Static Members Declaration << no methods >>
 * ---------------------------------------------------------------- */

// anything not listed here will be serialized/deserialized as strings
Bcp.typesMap = {
	SQLBIT: Boolean,
	SQLTINYINT: Number,
	SQLSMALLINT: Number,
	SQLINT: Number,
	SQLBIGINT: Number,
	SQLFLT4: Number,
	SQLFLT8: Number,
	SQLDATETIME: Date,
	SQLDATETIM4: Date,
	SQLDATETIM8: Date
};

/* -------------------------------------------------------------------
 * Public Static Methods << Keep in alphabetical order >>
 * ---------------------------------------------------------------- */

/**
 * 
 * @param filename {string}
 * @param format {FormatFile}
 * @param callback
 */
Bcp.readExport = function (filename, format, callback)
{
	// TODO: support streaming
	Fs.readFile(filename, { encoding: format.encoding }, function (error, data)
	{
		if (error)
		{
			callback(error);
			return;
		}
		
		var rows = [];
		var i = 0;
		/** @type {Field} */
		var f;
		var c, o, t;
		var fLength = format.fields.length;
		var terms = format.fields.map(function (f) { return f.terminator; });
		var dex;
		data_loop:
		while (i < data.length)
		{
			o = {};
			for (c = 0; c < fLength; c++)
			{
				t = terms[c];
				dex = data.indexOf(t, i);
				if (dex === -1)
					break data_loop;
				
				f = format.fields[c];
				o[f.name] = fieldDeserialize(data.substring(i, dex), f);
				i = dex + t.length;
			}
			
			debug(o);
			
			rows.push(o);
		}
		
		callback(null, rows);
	});
};

/* -------------------------------------------------------------------
 * Public Methods << Keep in alphabetical order >>
 * ---------------------------------------------------------------- */

Bcp.prototype.bulkExport = function (table, options, callback)
{
	if (typeof options === 'function')
	{
		callback = options;
		options = null;
	}
	
	var defaultOptions = {
		read: true,
		keepFiles: false
	};
	
	options = mergeOptions(defaultOptions, options);
	
	if (!options.read)
		options.keepFiles = true;
	
	var common = getCommonArgs(this);
	table = getQualifiedTable(this, table);
	
	var base = tempFile(this);
	var formatFile = options.formatFile || base + '_format.xml';
	var exportFile = options.exportFile || base + '_export.dat';
	
	var _this = this;
	var format, rows;
	var details = {
		formatFile: formatFile,
		exportFile: exportFile,
		rowCount: 0,
		stdout: null
	};
	
	Athena.waterfall(
		[
			function (cb)
			{
				ensureDirectories(formatFile, exportFile, cb);
			},
			function (cb)
			{
				formatGenerate(_this, table, formatFile, common, cb);
			},
			function (cb, f)
			{
				format = f;
//				debug(format);
				
				var cmd = _this.exec + ' ' + table + ' out ' + JSON.stringify(exportFile) + ' ' + common.join(' ');
				debug('Performing bulk export...');
				debug(cmd);
				ChildProcess.exec(cmd, { timeout: _this.timeout, killSignal: _this.killSignal }, cb);
			},
			function (cb, stdout)
			{
				debug(stdout);
				details.stdout = stdout;
				var match = /(\d+) rows copied\./.exec(stdout);
				if (match)
					details.rowCount = Number(match[1]);
				debug('Reading exported file...');
				
				if (options.read)
					Bcp.readExport(exportFile, format, cb);
				else
					cb(null, null);
			},
			function (cb, r)
			{
				rows = r;
				
				if (options.keepFiles)
				{
					cb();
				}
				else
				{
					// cleanup temp files
					Athena.parallel(
						[
							function (cb)
							{
								Fs.unlink(formatFile, cb);
							},
							function (cb)
							{
								Fs.unlink(exportFile, cb);
							}
						],
						cb
					);
				}
			}
		],
		function (hlog)
		{
			if (hlog.failed)
				callback(hlog);
			else
				callback(null, rows, details);
		}
	);
};

/**
 * 
 * @param importFilename {string}
 * @param format {FormatFile}
 * @param table {string}
 * @param [options]
 * @param callback
 */
Bcp.prototype.bulkInsert = function (importFilename, format, table, options, callback)
{
	if (typeof options === 'function')
	{
		callback = options;
		options = null;
	}

	var defaultOptions = {
		keepFiles: false
	};

	options = mergeOptions(defaultOptions, options);
	
	var _this = this;
	
	Athena.waterfall(
		[
			function (cb)
			{
				var common = getCommonArgs(_this, true);
				table = getQualifiedTable(_this, table);
				var cmd = _this.exec + ' ' + table + ' in ' + JSON.stringify(importFilename) + ' -f ' + JSON.stringify(format.filename) + ' ' + common.join(' ');
				debug('Performing bulk insert...');
				debug(cmd);
				ChildProcess.exec(cmd, { timeout: _this.timeout, killSignal: _this.killSignal }, cb);
			},
			function (cb, stdout)
			{
				debug(stdout);
				if (options.keepFiles)
				{
					cb();
				}
				else
				{
					// cleanup temp files
					Athena.parallel(
						[
							function (cb)
							{
								Fs.unlink(format.filename, cb);
							},
							function (cb)
							{
								Fs.unlink(importFilename, cb);
							}
						],
						cb
					);
				}
			}
		],
		function (hlog)
		{
			callback(hlog.failed ? hlog : null);
		}
	);
};

Bcp.prototype.prepareBulkInsert = function (table, columns, options, callback)
{
	if (typeof options === 'function')
	{
		callback = options;
		options = null;
	}

	var base = tempFile(this);
	var defaultOptions = {
		formatFile: base + '_format.xml',
		importFile: base + '_import.dat'
	};

	options = mergeOptions(defaultOptions, options);
	
	var _this = this;
	var common = getCommonArgs(this);
	var fullTable = getQualifiedTable(this, table);
	/** @type {FormatFile} */
	var format, imp;
	
	Athena.waterfall(
		[
			function (cb)
			{
				ensureDirectories(options.formatFile, options.importFile, cb);
			},
			function (cb)
			{
				formatGenerate(_this, fullTable, options.formatFile, common, cb);
			},
			function (cb, f)
			{
				format = f;

				// check to make sure the format contains all of the columns
				var reorderedFields = [];
				var origFieldNames = format.fields.map(function (f) { return f.name.toLowerCase(); });
				var dex;
				for (var i = 0; i < columns.length; i++)
				{
					dex = origFieldNames.indexOf(columns[i].toLowerCase());
					if (dex === -1)
					{
						cb(new Error(fullTable + ' does not contain column ' + columns[i]));
						return;
					}

					format.fields[dex].name = columns[i];
					format.fields[dex].inImport = true;
				}

//				debug(require('util').inspect(format, {depth:Infinity}));
				debug('Creating Import File...');
				imp = new ImportFile(_this, format, table, options.importFile, _this.unicode ? 'ucs2' : 'ascii');
				cb();
			}
		],
		function (hlog)
		{
			if (hlog.failed)
				callback(hlog);
			else
				callback(null, imp);
		}
	);
};

//Bcp.prototype.queryOut = function (query, callback)
//{
//};

/* -------------------------------------------------------------------
 * Private Methods << Keep in alphabetical order >>
 * ---------------------------------------------------------------- */

function ensureDirectories ()
{
	var dirs = [];
	var len = arguments.length - 1;
	var callback = arguments[len];
	var d;
	for (var i = 0; i < len; i++)
	{
		d = Path.dirname(Path.resolve(process.cwd(), arguments[i]));
		if (dirs.indexOf(d) === -1)
			dirs.push(d);
	}
	
	Athena.map(
		dirs,
		function (cb, d) { mkdirp(d, cb); },
		callback
	);
}

/**
 * 
 * @param value {string}
 * @param field {Field}
 */
function fieldDeserialize (value, field)
{
	debug('deserialize value: "' + value + '"');
	var cons = Bcp.typesMap[field.type];
	
	if (value === '')
		return null;
	
	if (value === NUL)
		return '';
	
	switch (cons)
	{
		case Date:
			return new Date(value);
		case Number:
			return Number(value);
		case Boolean:
			return value === '1';
		default:
			return value;
	}
}

/**
 * Generate format file using bcp, and load into a FormatFile object.
 * @param bcp {Bcp}
 * @param table {string}
 * @param file {string}
 * @param args {string[]}
 * @param callback
 */
function formatGenerate (bcp, table, file, args, callback)
{
	var cmd = bcp.exec + ' ' + table + ' format nul -x -f ' + JSON.stringify(file) + ' ' + args.join(' ');
	debug('Getting format file from bcp...');
	debug(cmd);
	ChildProcess.exec(cmd, { timeout: bcp.timeout, killSignal: bcp.killSignal }, function (error)
	{
		if (error)
		{
			callback(error);
			return;
		}

		// read xml format file
		debug('Reading format file ' + file);
		FormatFile.fromFile(file, callback);
	});
}

/**
 * @param bcp {Bcp}
 * @param omitFormat {boolean}
 * @return {string[]}
 */
function getCommonArgs (bcp, omitFormat)
{
	var args = [];
	
	if (bcp.packetSize)
	{
		args.push('-a');
		args.push(Number(bcp.packetSize));
	}
	
	if (bcp.batchSize)
	{
		args.push('-b');
		args.push(Number(bcp.batchSize));
	}
	
	if (!omitFormat)
	{
		if (bcp.unicode)
			args.push('-w');
		else
			args.push('-c');
	}
	
	if (bcp.codePage && !omitFormat)
	{
		args.push('-C');
		args.push(JSON.stringify(String(bcp.codePage)));
	}
	
	if (bcp.errorFile)
	{
		args.push('-e');
		args.push(JSON.stringify(String(bcp.errorFile)));
	}
	
	if (bcp.useIdentity)
		args.push('-E');

	if (bcp.firstRow)
	{
		args.push('-F');
		args.push(Number(bcp.firstRow));
	}
	
	if (bcp.inputFile)
	{
		args.push('-i');
		args.push(JSON.stringify(String(bcp.inputFile)));
	}

	if (bcp.readOnly)
	{
		args.push('-K');
		args.push('ReadOnly');
	}

	if (bcp.keepNulls)
		args.push('-k');

	if (bcp.lastRow)
	{
		args.push('-L');
		args.push(Number(bcp.lastRow));
	}
	
	if (bcp.maxErrors)
	{
		args.push('-m');
		args.push(Number(bcp.maxErrors));
	}

	if (bcp.regional)
		args.push('-R');

	if (bcp.rowTerminator && !omitFormat)
	{
		switch (bcp.rowTerminator[0])
		{
			case '-':
			case '/':
				args.push('-r' + bcp.rowTerminator);
				break;
			default:
				args.push('-r');
				args.push(JSON.stringify(String(bcp.rowTerminator)));
		}
	}

	if (bcp.server)
	{
		args.push('-S');
		args.push(JSON.stringify(String(bcp.server)));
	}

	if (bcp.fieldTerminator && !omitFormat)
	{
		switch (bcp.fieldTerminator[0])
		{
			case '-':
			case '/':
				args.push('-t' + bcp.fieldTerminator);
				break;
			default:
				args.push('-t');
				args.push(JSON.stringify(String(bcp.fieldTerminator)));
		}
	}

	if (bcp.trusted)
	{
		args.push('-T');
	}
	else
	{
		if (bcp.user)
		{
			args.push('-U');
			args.push(JSON.stringify(String(bcp.user)));
		}

		if (bcp.password)
		{
			args.push('-P');
			args.push(JSON.stringify(String(bcp.password)));
		}
	}
	
	var hints = [];
	
	if (bcp.order)
		hints.push('ORDER(' + bcp.order + ')');
	
	if (bcp.rowsPerBatch)
		hints.push('ROWS_PER_BATCH=' + Number(bcp.rowsPerBatch));
	
	if (bcp.kbPerBatch)
		hints.push('KILOBYTES_PER_BATCH=' + Number(bcp.kbPerBatch));
	
	if (bcp.tabLock)
		hints.push('TABLOCK');
	
	if (bcp.checkConstraints)
		hints.push('CHECK_CONSTRAINTS');
	
	if (bcp.fireTriggers)
		hints.push('FIRE_TRIGGERS');
	
	if (hints.length > 0)
	{
		args.push('-h');
		args.push(JSON.stringify(hints.join(',')));
	}
	
	return args;
}

/**
 * 
 * @param bcp {Bcp}
 * @param table {string}
 * @return {string}
 */
function getQualifiedTable (bcp, table)
{
	var arg = '[' + table + ']';
	if (bcp.schema)
		arg = '[' + bcp.schema + '].' + arg;
	
	if (bcp.database)
		arg = '[' + bcp.database + '].' + arg;
	
	if (bcp.quotedIdentifiers)
		arg = JSON.stringify(arg);
	
	return arg;
}

function mergeOptions (defaults, overrides)
{
	if (!overrides)
		return defaults;
	
	for (var i in defaults)
	{
		if (i in overrides)
			defaults[i] = overrides[i];
	}
	
	return defaults;
}

/**
 * @param bcp {Bcp}
 */
function tempFile (bcp)
{
	var base = new Date().getTime() + '_' + Math.floor(Math.random() * 4000000000) + '_' + process.pid;
	return Path.join(bcp.tmp, base);
}