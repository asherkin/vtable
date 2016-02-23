DEBUG ?= 0

vtable.js: main.cpp build-libelf/lib/libelf.a is_debug
ifeq ($(DEBUG), 1)
	em++ --bind --std=c++14 --memory-init-file 0 -s ASSERTIONS=1 -s DEMANGLE_SUPPORT=1 -s ALLOW_MEMORY_GROWTH=1 -s AGGRESSIVE_VARIABLE_ELIMINATION=1 -s WARN_UNALIGNED=1 -s NO_FILESYSTEM=1 -s NO_BROWSER=1 -Ibuild-libelf/lib -Ilibelf-0.8.13/lib -o vtable.js main.cpp build-libelf/lib/libelf.a
else
	em++ --bind --std=c++14 -O3 --llvm-lto 1 --closure 1 --memory-init-file 0 -s DEMANGLE_SUPPORT=1 -s ALLOW_MEMORY_GROWTH=1 -s AGGRESSIVE_VARIABLE_ELIMINATION=1 -s WARN_UNALIGNED=1 -s NO_FILESYSTEM=1 -s NO_BROWSER=1 -Ibuild-libelf/lib -Ilibelf-0.8.13/lib -o vtable.js main.cpp build-libelf/lib/libelf.a
endif

.PHONY: force clean distclean test

is_debug: force
	@echo '$(DEBUG)' | cmp -s - $@ || echo '$(DEBUG)' > $@

gh-pages: test.html vtable.js
	rm -rf gh-pages
	mkdir gh-pages
	cp test.html gh-pages/index.html
	cp vtable.js gh-pages/

clean:
	rm -rf vtable.js build-libelf libelf-0.8.13

distclean: clean
	rm -rf libelf-0.8.13.tar.gz engine_srv.so

test: test.js vtable.js engine_srv.so
	node test.js

engine_srv.so:
	curl -o engine_srv.so 'http://users.alliedmods.net/~asherkin/public/bins/source/tf2/bin/engine_srv.so'

build-libelf/lib/libelf.a: build-libelf libelf-0.8.13
	cd build-libelf && emconfigure ../libelf-0.8.13/configure --enable-shared=no && emmake make

build-libelf:
	mkdir build-libelf

libelf-0.8.13: libelf-0.8.13.tar.gz
	tar -xzf libelf-0.8.13.tar.gz && touch libelf-0.8.13

libelf-0.8.13.tar.gz:
	curl -o libelf-0.8.13.tar.gz 'http://www.mr511.de/software/libelf-0.8.13.tar.gz'
