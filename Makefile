vtable.js: main.cpp build-libelf/lib/libelf.a
	em++ --bind --std=c++14 -O3 --llvm-lto 1 --closure 1 --memory-init-file 0 -s ALLOW_MEMORY_GROWTH=1 -s AGGRESSIVE_VARIABLE_ELIMINATION=1 -s WARN_UNALIGNED=1 -s NO_FILESYSTEM=1 -s NO_BROWSER=1 -Ibuild-libelf/lib -Ilibelf-0.8.13/lib -o vtable.js main.cpp build-libelf/lib/libelf.a

.PHONY: clean distclean test

clean:
	rm -rf vtable.js build-libelf libelf-0.8.13

distclean: clean
	rm -rf libelf-0.8.13.tar.gz server_srv.so

test: test.js vtable.js server_srv.so
	node test.js

server_srv.so:
	curl -o server_srv.so 'http://users.alliedmods.net/~asherkin/public/bins/source/tf2/tf/bin/server_srv.so'

build-libelf/lib/libelf.a: build-libelf libelf-0.8.13
	cd build-libelf && emconfigure ../libelf-0.8.13/configure --enable-shared=no && emmake make

build-libelf:
	mkdir build-libelf

libelf-0.8.13: libelf-0.8.13.tar.gz
	tar -xzf libelf-0.8.13.tar.gz && touch libelf-0.8.13

libelf-0.8.13.tar.gz:
	curl -o libelf-0.8.13.tar.gz 'http://www.mr511.de/software/libelf-0.8.13.tar.gz'
