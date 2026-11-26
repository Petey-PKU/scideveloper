local({
  run_cell <- function(source, output, workspace, prefix) {
    assign("SCIDEV_OUTPUT_DIR", output, envir = .GlobalEnv)
    assign("SCIDEV_WORKSPACE_DIR", workspace, envir = .GlobalEnv)
    old_directory <- setwd(output)
    on.exit(setwd(old_directory), add = TRUE)

    figure_prefix <- gsub("%", "%%", file.path(output, prefix), fixed = TRUE)
    device_index <- 0L
    old_options <- options(device = function() {
      device_index <<- device_index + 1L
      pattern <- paste0(figure_prefix, "_", device_index, "_%03d.png")
      grDevices::png(pattern, width = 1200, height = 900, res = 180)
    })
    on.exit({
      grDevices::graphics.off()
      options(old_options)
    }, add = TRUE)
    if (capabilities("cairo")) options(bitmapType = "cairo")
    base::source(source, local = .GlobalEnv, encoding = "UTF-8", print.eval = TRUE)
  }
  args <- commandArgs(trailingOnly = TRUE)
  version <- as.character(getRversion())
  if (!length(args) || args[[1]] != "--persistent") {
    writeLines(version, args[[4]])
    run_cell(args[[1]], args[[2]], args[[3]], args[[5]])
  } else {
    # Hex UTF-8 strings keep the JSON-RPC wire format independent of optional R packages.
    from_hex <- function(value) {
      if (!nzchar(value)) return("")
      indices <- seq.int(1L, nchar(value), 2L)
      text <- rawToChar(as.raw(strtoi(substring(value, indices, indices + 1L), 16L)))
      Encoding(text) <- "UTF-8"
      text
    }
    to_hex <- function(value) paste(format(value), collapse = "")
    text_hex <- function(value) to_hex(charToRaw(enc2utf8(value)))
    variables <- function() {
      bindings <- ls(envir = .GlobalEnv)
      entries <- lapply(bindings[!startsWith(bindings, "SCIDEV_")], function(name) {
        if (bindingIsActive(name, .GlobalEnv)) return(NULL)
        value <- get(name, envir = .GlobalEnv, inherits = FALSE)
        if (is.function(value)) return(NULL)
        dimensions <- dim(value)
        shape <- if (length(dimensions)) paste(dimensions, collapse = " \u00d7 ") else as.character(length(value))
        preview <- paste(utils::capture.output(utils::str(value, max.level = 1L, vec.len = 4L)), collapse = "\n")
        columns <- if (is.data.frame(value)) utils::head(names(value), 30L) else character()
        sprintf('{"name":"%s","typeName":"%s","shape":"%s","sizeBytes":%.0f,"preview":"%s","columns":[%s]}',
                text_hex(name), text_hex(class(value)[[1L]]), text_hex(shape), as.numeric(utils::object.size(value)),
                text_hex(substr(preview, 1L, 300L)),
                paste(vapply(columns, function(column) sprintf('"%s"', text_hex(column)), ""), collapse = ","))
      })
      paste0("[", paste(Filter(Negate(is.null), entries), collapse = ","), "]")
    }
    read_capture <- function(file) {
      size <- file.size(file)
      limit <- 1024L * 1024L
      value <- readBin(file, "raw", n = min(size, limit))
      if (size > limit) value <- c(value, charToRaw("\n[R output truncated]\n"))
      value
    }
    execute <- function(code, output, workspace, prefix) {
      output_path <- tempfile()
      error_path <- tempfile()
      output_capture <- file(output_path, open = "wt", encoding = "UTF-8")
      error_capture <- file(error_path, open = "wt", encoding = "UTF-8")
      source <- textConnection(code, encoding = "UTF-8")
      on.exit({
        close(source)
        unlink(c(output_path, error_path))
      }, add = TRUE)
      output_depth <- sink.number()
      old_options <- options(warn = 1L)
      sink(output_capture)
      sink(error_capture, type = "message")
      exit_code <- tryCatch({
        run_cell(source, output, workspace, prefix)
        0L
      }, error = function(error) {
        cat("Error:", conditionMessage(error), "\n", file = error_capture)
        1L
      }, finally = {
        sink(type = "message")
        while (sink.number() > output_depth) sink()
        close(output_capture)
        close(error_capture)
        options(old_options)
      })
      sprintf('{"exitCode":%d,"stdoutHex":"%s","stderrHex":"%s","rVersion":"%s"}',
              exit_code, to_hex(read_capture(output_path)), to_hex(read_capture(error_path)), version)
    }
    request_pattern <- paste0('^\\{"jsonrpc":"2\\.0","id":"([a-f0-9-]+)","method":"(exec|vars)",',
                              '"params":\\[(?:"([a-f0-9]*)","([a-f0-9]*)","([a-f0-9]*)","([a-f0-9]*)")?\\]\\}$')
    input <- file("stdin", open = "r")
    output <- stdout()
    writeLines(sprintf('{"jsonrpc":"2.0","method":"ready","params":{"version":"%s"}}', version), output)
    flush(output)
    repeat {
      line <- readLines(input, n = 1L, warn = FALSE)
      if (!length(line)) break
      request <- regmatches(line, regexec(request_pattern, line, perl = TRUE))[[1]]
      if (!length(request)) next
      result <- if (request[[3]] == "vars") {
        tryCatch(variables(), error = function(error) "[]")
      } else {
        tryCatch(do.call(execute, lapply(request[4:7], from_hex)), error = function(error) {
          sprintf('{"exitCode":1,"stdoutHex":"","stderrHex":"%s","rVersion":"%s"}',
                  text_hex(conditionMessage(error)), version)
        })
      }
      writeLines(sprintf('{"jsonrpc":"2.0","id":"%s","result":%s}', request[[2]], result), output)
      flush(output)
    }
    close(input)
  }
}, envir = new.env(parent = baseenv()))
